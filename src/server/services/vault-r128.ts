/**
 * R128 Team password vault (flag VAULT_R128, Tools feature vault_r128). The server never sees a secret: it stores the
 * ciphertext the browser made and enforces who may fetch which ciphertext and wrapped keys. Key model:
 * files/catalogue/r128/DESIGN.md. Rules here:
 * - people signed in to the workspace only (sessions; never keys, agents, project guests or portal users); vv8k is out;
 * - owners and admins create folders and manage access; everyone else sees only folders whose key was wrapped for them;
 * - the wrapped private key leaves only after the right unlock proof; wrong proofs pause unlock (5 in a row, 15 min, doubling);
 * - removing someone from a folder deletes their wrapped keys and marks the folder for rotation;
 * - nothing here logs or returns a request body; errors carry plain words, never a value.
 */
import { sql } from "drizzle-orm";
import type { AuthContext, Deps } from "../context";
import { HttpError, badRequest, forbidden } from "../lib/errors";
import { newId } from "../lib/crypto";
import {
  B64U, VAULT_ACCESS, VAULT_CLIENT_ACTIONS, VAULT_FIELDS, VAULT_FOLDER_ID, VAULT_ITEM_ID, VAULT_KDF_MIN_ITERATIONS, VAULT_LOCK_FAILS,
  VAULT_MAX_FOLDERS, VAULT_MAX_ITEMS_PER_FOLDER, VAULT_MAX_ITEM_CT, VAULT_MAX_MEMBERS_PER_FOLDER, VAULT_MAX_NAME_CT, lockoutMs,
  type VaultAccess, type VaultFolderDto, type VaultItemDto, type VaultPersonDto, type VaultStateDto,
} from "@/shared/vault-r128";

export type VaultAuth = Pick<AuthContext, "orgId" | "userId" | "email" | "name" | "role">;
type Body = Record<string, unknown>;

const nowMs = (deps: Deps) => deps.now().getTime();
const isAdmin = (a: VaultAuth) => a.role === "owner" || a.role === "admin";
const changes = (r: unknown) => Number((r as { meta?: { changes?: number } })?.meta?.changes ?? (r as { changes?: number })?.changes ?? (r as { rowsAffected?: number })?.rowsAffected ?? 0);
const CHUNK = 12; // rows per multi row statement (D1 allows 100 bound values)

// ---------------------------------------------------------------- input checks (pure)

export function b64u(v: unknown, what: string, max: number, min = 1): string {
  if (typeof v !== "string" || v.length < min || v.length > max || !B64U.test(v)) throw badRequest(`${what} is not valid.`);
  return v;
}
const int = (v: unknown, what: string) => { if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw badRequest(`${what} is not valid.`); return v; };
const access = (v: unknown): VaultAccess => { if (!VAULT_ACCESS.includes(v as VaultAccess)) throw badRequest("Choose an access level."); return v as VaultAccess; };

/** The vault stays out of the client workspace (and any listed in VAULT_EXCLUDE). */
export function isVaultExcluded(org: { id: string; slug?: string | null; name?: string | null }, extra = ""): boolean {
  const hay = [org.id, org.slug ?? "", org.name ?? ""].map((s) => s.toLowerCase());
  const words = ["vv8k", ...extra.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)];
  return words.some((x) => hay.some((h) => h === x || h.includes(x)));
}

export async function assertVaultOpen(deps: Deps, a: VaultAuth): Promise<void> {
  if (!deps.config.vaultR128) throw new HttpError(404, "not_found", "Page not found.");
  if (!a.userId) throw forbidden("Vault is for people signed in to the workspace.");
  const [o] = await deps.db.all<{ id: string; slug: string | null; name: string | null }>(sql`select id, slug, name from organizations where id = ${a.orgId} limit 1`);
  if (!o || isVaultExcluded(o, deps.config.vaultExclude ?? "")) throw new HttpError(404, "not_found", "Page not found.");
}

async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
/** Constant time compare of two hex strings of equal length. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function audit(deps: Deps, a: VaultAuth, action: string, x: { folderId?: string | null; itemId?: string | null; field?: string | null; userId?: string } = {}) {
  await deps.db.run(sql`insert into vault_audit (id, org_id, user_id, user_name, folder_id, item_id, action, field, at)
    values (${newId("vau")}, ${a.orgId}, ${x.userId ?? a.userId}, ${a.name || a.email || ""}, ${x.folderId ?? null}, ${x.itemId ?? null}, ${action}, ${x.field ?? null}, ${nowMs(deps)})`);
}

// ---------------------------------------------------------------- account

interface AccountRow { public_key: string; fingerprint: string; wrapped_private_key: string; kdf_salt: string; kdf_iterations: number; auth_hash: string; failed_count: number; lockouts: number; locked_until: number | null }
const accountOf = (deps: Deps, a: VaultAuth) =>
  deps.db.get<AccountRow>(sql`select public_key, fingerprint, wrapped_private_key, kdf_salt, kdf_iterations, auth_hash, failed_count, lockouts, locked_until from vault_accounts where org_id = ${a.orgId} and user_id = ${a.userId}`);

export async function vaultState(deps: Deps, a: VaultAuth, shareOn: boolean): Promise<VaultStateDto> {
  const acc = await accountOf(deps, a);
  const now = nowMs(deps);
  return {
    isAdmin: isAdmin(a), setUp: !!acc, kdf: acc ? { salt: acc.kdf_salt, iterations: acc.kdf_iterations } : null, fingerprint: acc?.fingerprint ?? null,
    lockedUntil: acc?.locked_until && acc.locked_until > now ? acc.locked_until : null, shareOn, userId: a.userId, orgId: a.orgId,
  };
}

/** Saves a new key pair: the public key in clear, the private key already encrypted in the browser. */
export async function setUpVault(deps: Deps, a: VaultAuth, b: Body) {
  const publicKey = b64u(b.publicKey, "Public key", 4096, 200);
  const wrapped = b64u(b.wrappedPrivateKey, "Encrypted key", 8192, 200);
  const salt = b64u(b.salt, "Salt", 64, 16);
  const auth = b64u(b.auth, "Unlock proof", 64, 40);
  const fingerprint = typeof b.fingerprint === "string" && /^[0-9a-f]{32}$/.test(b.fingerprint) ? b.fingerprint : null;
  if (!fingerprint) throw badRequest("Fingerprint is not valid.");
  const iterations = int(b.iterations, "Iterations");
  if (iterations < VAULT_KDF_MIN_ITERATIONS || iterations > 10_000_000) throw badRequest("The passphrase protection is too weak.");
  if (await accountOf(deps, a)) throw new HttpError(409, "vault_exists", "Your vault is already set up.");
  const now = nowMs(deps);
  await deps.db.run(sql`insert into vault_accounts (org_id, user_id, public_key, fingerprint, wrapped_private_key, kdf_salt, kdf_iterations, auth_hash, created_at, updated_at)
    values (${a.orgId}, ${a.userId}, ${publicKey}, ${fingerprint}, ${wrapped}, ${salt}, ${iterations}, ${await sha256Hex(auth)}, ${now}, ${now})`);
  await audit(deps, a, "setup");
  return vaultState(deps, a, false);
}

/** Checks the unlock proof; only then hands out the encrypted private key. Wrong proofs pause unlock. */
export async function unlockVault(deps: Deps, a: VaultAuth, b: Body): Promise<{ wrappedPrivateKey: string; publicKey: string }> {
  const auth = b64u(b.auth, "Unlock proof", 64, 40);
  const acc = await accountOf(deps, a);
  if (!acc) throw new HttpError(404, "vault_not_set_up", "Set up your vault first.");
  const now = nowMs(deps);
  if (acc.locked_until && acc.locked_until > now) throw pausedError(acc.locked_until, now);
  if (sameHex(await sha256Hex(auth), acc.auth_hash)) {
    if (acc.failed_count || acc.locked_until) await deps.db.run(sql`update vault_accounts set failed_count = 0, locked_until = null where org_id = ${a.orgId} and user_id = ${a.userId}`);
    return { wrappedPrivateKey: acc.wrapped_private_key, publicKey: acc.public_key };
  }
  const fails = acc.failed_count + 1;
  if (fails >= VAULT_LOCK_FAILS) {
    const lockouts = acc.lockouts + 1;
    const until = now + lockoutMs(lockouts);
    await deps.db.run(sql`update vault_accounts set failed_count = 0, lockouts = ${lockouts}, locked_until = ${until} where org_id = ${a.orgId} and user_id = ${a.userId}`);
    await audit(deps, a, "locked_out");
    throw pausedError(until, now);
  }
  await deps.db.run(sql`update vault_accounts set failed_count = ${fails} where org_id = ${a.orgId} and user_id = ${a.userId}`);
  await audit(deps, a, "unlock_failed");
  throw new HttpError(401, "vault_wrong_passphrase", "Wrong passphrase.", { triesLeft: VAULT_LOCK_FAILS - fails });
}
function pausedError(until: number, now: number) {
  const mins = Math.max(1, Math.ceil((until - now) / 60_000));
  return new HttpError(429, "vault_paused", `Too many wrong tries. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`, { lockedUntil: until });
}

/** New passphrase: the old proof must match; the browser sends the private key wrapped under the new passphrase. */
export async function changePassphrase(deps: Deps, a: VaultAuth, b: Body) {
  await unlockVault(deps, a, { auth: b.auth });
  const wrapped = b64u(b.wrappedPrivateKey, "Encrypted key", 8192, 200);
  const salt = b64u(b.salt, "Salt", 64, 16);
  const auth = b64u(b.newAuth, "Unlock proof", 64, 40);
  const iterations = int(b.iterations, "Iterations");
  if (iterations < VAULT_KDF_MIN_ITERATIONS || iterations > 10_000_000) throw badRequest("The passphrase protection is too weak.");
  await deps.db.run(sql`update vault_accounts set wrapped_private_key = ${wrapped}, kdf_salt = ${salt}, kdf_iterations = ${iterations}, auth_hash = ${await sha256Hex(auth)},
    failed_count = 0, locked_until = null, updated_at = ${nowMs(deps)} where org_id = ${a.orgId} and user_id = ${a.userId}`);
  await audit(deps, a, "passphrase_change");
  return { ok: true };
}

/** Forgot the passphrase: deletes the key pair and every folder key of this person; their folders need a new key. */
export async function resetVault(deps: Deps, a: VaultAuth, b: Body) {
  if (b.confirm !== "reset") throw badRequest("Type reset to confirm.");
  await dropPerson(deps, a.orgId, a.userId);
  await deps.db.run(sql`delete from vault_accounts where org_id = ${a.orgId} and user_id = ${a.userId}`);
  await audit(deps, a, "reset");
  return { ok: true };
}

/** Removes every wrapped key a person holds in this workspace and marks those folders for rotation. */
async function dropPerson(deps: Deps, orgId: string, userId: string) {
  const rows = await deps.db.all<{ folder_id: string }>(sql`select distinct folder_id from vault_folder_keys where org_id = ${orgId} and user_id = ${userId}`);
  await deps.db.run(sql`delete from vault_folder_keys where org_id = ${orgId} and user_id = ${userId}`);
  for (let i = 0; i < rows.length; i += 50) {
    const ids = rows.slice(i, i + 50).map((r) => r.folder_id);
    await deps.db.run(sql`update vault_folders set needs_rotation = 1, updated_at = ${nowMs(deps)} where org_id = ${orgId} and id in (${sql.join(ids.map((x) => sql`${x}`), sql`, `)})`);
  }
}

/** People who left the workspace keep no folder keys: drop them and mark their folders (runs when a manager lists access). */
async function dropLeavers(deps: Deps, orgId: string, folderId: string) {
  const gone = await deps.db.all<{ user_id: string }>(sql`select distinct k.user_id from vault_folder_keys k
    left join members m on m.organization_id = k.org_id and m.user_id = k.user_id
    where k.folder_id = ${folderId} and k.org_id = ${orgId} and m.user_id is null`);
  for (const g of gone) await dropPerson(deps, orgId, g.user_id);
}

// ---------------------------------------------------------------- people (for giving access)

export async function vaultPeople(deps: Deps, a: VaultAuth): Promise<VaultPersonDto[]> {
  if (!isAdmin(a)) throw forbidden("Only owners and admins can give access.");
  const rows = await deps.db.all<{ id: string; name: string | null; email: string; role: VaultPersonDto["role"]; public_key: string | null; fingerprint: string | null }>(sql`
    select u.id, u.name, u.email, m.role, v.public_key, v.fingerprint from members m join users u on u.id = m.user_id
    left join vault_accounts v on v.org_id = m.organization_id and v.user_id = m.user_id
    where m.organization_id = ${a.orgId} and coalesce(m.kind, 'human') = 'human' order by coalesce(u.name, u.email) limit 500`);
  return rows.map((r) => ({ userId: r.id, name: r.name || r.email, email: r.email, role: r.role, publicKey: r.public_key, fingerprint: r.fingerprint }));
}

// ---------------------------------------------------------------- folders

interface KeyRow { folder_id: string; key_version: number; wrapped_key: string; access: VaultAccess }
interface FolderRow { id: string; name_ct: string; key_version: number; needs_rotation: number; updated_at: number; n: number }

async function myAccess(deps: Deps, a: VaultAuth, folderId: string): Promise<{ folder: FolderRow; access: VaultAccess }> {
  if (typeof folderId !== "string" || !VAULT_FOLDER_ID.test(folderId)) throw new HttpError(404, "not_found", "Folder not found.");
  const f = await deps.db.get<FolderRow>(sql`select id, name_ct, key_version, needs_rotation, updated_at, 0 as n from vault_folders where id = ${folderId} and org_id = ${a.orgId}`);
  const k = f && await deps.db.get<{ access: VaultAccess }>(sql`select access from vault_folder_keys where folder_id = ${folderId} and user_id = ${a.userId} and org_id = ${a.orgId} order by key_version desc limit 1`);
  // Members never learn whether a folder they are not in exists.
  if (!f || !k) throw new HttpError(404, "not_found", "Folder not found.");
  // Access is checked against the live role too: an admin made a member loses manage at once.
  const acc = k.access === "manage" && !isAdmin(a) ? "edit" : k.access;
  return { folder: f, access: acc };
}
const canEdit = (x: VaultAccess) => x === "edit" || x === "manage";

export async function listFolders(deps: Deps, a: VaultAuth): Promise<VaultFolderDto[]> {
  const keys = await deps.db.all<KeyRow>(sql`select folder_id, key_version, wrapped_key, access from vault_folder_keys where org_id = ${a.orgId} and user_id = ${a.userId} limit 2000`);
  if (!keys.length) return [];
  const ids = [...new Set(keys.map((k) => k.folder_id))];
  const out: VaultFolderDto[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    const rows = await deps.db.all<FolderRow>(sql`select f.id, f.name_ct, f.key_version, f.needs_rotation, f.updated_at, (select count(*) from vault_items i where i.folder_id = f.id) as n
      from vault_folders f where f.org_id = ${a.orgId} and f.id in (${sql.join(part.map((x) => sql`${x}`), sql`, `)})`);
    for (const f of rows) {
      const mine = keys.filter((k) => k.folder_id === f.id);
      const top = mine.reduce((m, k) => (k.key_version > m.key_version ? k : m), mine[0]!);
      out.push({
        id: f.id, nameCt: f.name_ct, keyVersion: f.key_version, needsRotation: !!f.needs_rotation, itemCount: Number(f.n), updatedAt: f.updated_at,
        access: top.access === "manage" && !isAdmin(a) ? "edit" : top.access, keys: mine.map((k) => ({ version: k.key_version, wrappedKey: k.wrapped_key })),
      });
    }
  }
  return out.sort((x, y) => x.id.localeCompare(y.id));
}

interface KeyInput { userId: string; wrappedKey: string; access?: VaultAccess }
function keyInputs(v: unknown, withAccess: boolean): KeyInput[] {
  if (!Array.isArray(v) || !v.length || v.length > VAULT_MAX_MEMBERS_PER_FOLDER) throw badRequest("Folder keys are not valid.");
  const seen = new Set<string>();
  return v.map((x) => {
    const o = (x ?? {}) as Body;
    if (typeof o.userId !== "string" || !o.userId || seen.has(o.userId)) throw badRequest("Folder keys are not valid.");
    seen.add(o.userId);
    return { userId: o.userId, wrappedKey: b64u(o.wrappedKey, "Folder key", 1024, 100), ...(withAccess ? { access: access(o.access) } : {}) };
  });
}

/** Checks each person is a human member of this workspace with a vault, and that manage goes to owners and admins only. */
async function checkPeople(deps: Deps, orgId: string, inputs: KeyInput[]) {
  for (let i = 0; i < inputs.length; i += 50) {
    const part = inputs.slice(i, i + 50);
    const rows = await deps.db.all<{ user_id: string; role: string }>(sql`select m.user_id, m.role from members m join vault_accounts v on v.org_id = m.organization_id and v.user_id = m.user_id
      where m.organization_id = ${orgId} and coalesce(m.kind, 'human') = 'human' and m.user_id in (${sql.join(part.map((x) => sql`${x.userId}`), sql`, `)})`);
    for (const p of part) {
      const r = rows.find((x) => x.user_id === p.userId);
      if (!r) throw badRequest("That person has not set up their vault yet.");
      if (p.access === "manage" && r.role !== "owner" && r.role !== "admin") throw badRequest("Only owners and admins can manage a folder.");
    }
  }
}

async function insertKeys(deps: Deps, orgId: string, folderId: string, version: number, grantedBy: string, rows: KeyInput[], defaultAccess: (u: string) => VaultAccess) {
  const now = nowMs(deps);
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    await deps.db.run(sql`insert into vault_folder_keys (folder_id, user_id, key_version, org_id, wrapped_key, access, granted_by, created_at) values ${sql.join(
      part.map((k) => sql`(${folderId}, ${k.userId}, ${version}, ${orgId}, ${k.wrappedKey}, ${k.access ?? defaultAccess(k.userId)}, ${grantedBy}, ${now})`), sql`, `)}
      on conflict (folder_id, user_id, key_version) do update set wrapped_key = excluded.wrapped_key, access = excluded.access`);
  }
}

export async function createFolder(deps: Deps, a: VaultAuth, b: Body) {
  if (!isAdmin(a)) throw forbidden("Only owners and admins can create folders.");
  if (!(await accountOf(deps, a))) throw new HttpError(409, "vault_not_set_up", "Set up your vault first.");
  const id = typeof b.id === "string" && VAULT_FOLDER_ID.test(b.id) ? b.id : null;
  if (!id) throw badRequest("Folder id is not valid.");
  const nameCt = b64u(b.nameCt, "Folder name", VAULT_MAX_NAME_CT, 20);
  const keys = keyInputs(b.keys, true);
  const me = keys.find((k) => k.userId === a.userId);
  if (!me || me.access !== "manage") throw badRequest("Keep yourself in the folder with manage access.");
  const n = await deps.db.get<{ n: number }>(sql`select count(*) as n from vault_folders where org_id = ${a.orgId}`);
  if (Number(n?.n ?? 0) >= VAULT_MAX_FOLDERS) throw badRequest(`A workspace can have up to ${VAULT_MAX_FOLDERS} vault folders.`);
  await checkPeople(deps, a.orgId, keys);
  if (await deps.db.get(sql`select 1 as x from vault_folders where id = ${id}`)) throw new HttpError(409, "exists", "That folder already exists.");
  const now = nowMs(deps);
  await deps.db.run(sql`insert into vault_folders (id, org_id, name_ct, key_version, needs_rotation, created_by, created_at, updated_at) values (${id}, ${a.orgId}, ${nameCt}, 1, 0, ${a.userId}, ${now}, ${now})`);
  await insertKeys(deps, a.orgId, id, 1, a.userId, keys, () => "view");
  await audit(deps, a, "folder_create", { folderId: id });
  return { id };
}

export async function renameFolder(deps: Deps, a: VaultAuth, folderId: string, b: Body) {
  const { folder, access: acc } = await myAccess(deps, a, folderId);
  if (acc !== "manage") throw forbidden("Only folder managers can rename it.");
  const nameCt = b64u(b.nameCt, "Folder name", VAULT_MAX_NAME_CT, 20);
  if (b.keyVersion !== folder.key_version) throw new HttpError(409, "vault_stale", "The folder key changed. Reload and try again.");
  await deps.db.run(sql`update vault_folders set name_ct = ${nameCt}, updated_at = ${nowMs(deps)} where id = ${folderId} and org_id = ${a.orgId}`);
  await audit(deps, a, "folder_rename", { folderId });
  return { ok: true };
}

export async function deleteFolder(deps: Deps, a: VaultAuth, folderId: string) {
  const { access: acc } = await myAccess(deps, a, folderId);
  if (acc !== "manage" || !isAdmin(a)) throw forbidden("Only owners and admins who manage this folder can delete it.");
  await deps.db.run(sql`delete from vault_items where folder_id = ${folderId} and org_id = ${a.orgId}`);
  await deps.db.run(sql`delete from vault_folder_keys where folder_id = ${folderId} and org_id = ${a.orgId}`);
  await deps.db.run(sql`delete from vault_folders where id = ${folderId} and org_id = ${a.orgId}`);
  await audit(deps, a, "folder_delete", { folderId });
  return { ok: true };
}

// ---------------------------------------------------------------- access

export async function folderAccess(deps: Deps, a: VaultAuth, folderId: string) {
  const { access: acc } = await myAccess(deps, a, folderId);
  if (acc !== "manage") throw forbidden("Only folder managers can see who has access.");
  await dropLeavers(deps, a.orgId, folderId);
  const f = await deps.db.get<{ key_version: number; needs_rotation: number }>(sql`select key_version, needs_rotation from vault_folders where id = ${folderId}`);
  const rows = await deps.db.all<{ user_id: string; access: VaultAccess; name: string | null; email: string; role: string; fingerprint: string | null }>(sql`
    select k.user_id, k.access, u.name, u.email, m.role, v.fingerprint from vault_folder_keys k join users u on u.id = k.user_id
    join members m on m.organization_id = k.org_id and m.user_id = k.user_id left join vault_accounts v on v.org_id = k.org_id and v.user_id = k.user_id
    where k.folder_id = ${folderId} and k.org_id = ${a.orgId} and k.key_version = ${f?.key_version ?? 0} order by coalesce(u.name, u.email)`);
  return {
    keyVersion: f?.key_version ?? 1, needsRotation: !!f?.needs_rotation,
    members: rows.map((r) => ({ userId: r.user_id, name: r.name || r.email, email: r.email, role: r.role, access: r.access, fingerprint: r.fingerprint })),
  };
}

export async function grantAccess(deps: Deps, a: VaultAuth, folderId: string, b: Body) {
  if (!isAdmin(a)) throw forbidden("Only owners and admins can give access.");
  const { folder, access: acc } = await myAccess(deps, a, folderId);
  if (acc !== "manage") throw forbidden("Only folder managers can give access.");
  if (folder.needs_rotation) throw new HttpError(409, "vault_needs_rotation", "Rotate the folder key first.");
  if (b.keyVersion !== folder.key_version) throw new HttpError(409, "vault_stale", "The folder key changed. Reload and try again.");
  const [k] = keyInputs([b], true);
  const count = await deps.db.get<{ n: number }>(sql`select count(*) as n from vault_folder_keys where folder_id = ${folderId} and key_version = ${folder.key_version}`);
  if (Number(count?.n ?? 0) >= VAULT_MAX_MEMBERS_PER_FOLDER) throw badRequest(`A folder can be shared with up to ${VAULT_MAX_MEMBERS_PER_FOLDER} people.`);
  await checkPeople(deps, a.orgId, [k!]);
  await insertKeys(deps, a.orgId, folderId, folder.key_version, a.userId, [k!], () => "view");
  await audit(deps, a, "grant", { folderId, field: k!.access, userId: a.userId });
  return { ok: true };
}

export async function changeAccess(deps: Deps, a: VaultAuth, folderId: string, userId: string, b: Body) {
  if (!isAdmin(a)) throw forbidden("Only owners and admins can change access.");
  const { access: acc } = await myAccess(deps, a, folderId);
  if (acc !== "manage") throw forbidden("Only folder managers can change access.");
  const next = access(b.access);
  if (userId === a.userId && next !== "manage") throw badRequest("You can't lower your own access.");
  await checkPeople(deps, a.orgId, [{ userId, wrappedKey: "", access: next }]);
  const r = await deps.db.run(sql`update vault_folder_keys set access = ${next} where folder_id = ${folderId} and user_id = ${userId} and org_id = ${a.orgId}`);
  if (!changes(r)) throw new HttpError(404, "not_found", "That person has no access to this folder.");
  await audit(deps, a, "access_change", { folderId, field: next });
  return { ok: true };
}

/** Removes a person: their wrapped keys go and the folder is marked; the manager's browser then rotates the key. */
export async function revokeAccess(deps: Deps, a: VaultAuth, folderId: string, userId: string) {
  if (!isAdmin(a)) throw forbidden("Only owners and admins can remove access.");
  const { access: acc } = await myAccess(deps, a, folderId);
  if (acc !== "manage") throw forbidden("Only folder managers can remove access.");
  if (userId === a.userId) throw badRequest("You can't remove yourself. Ask another admin.");
  const r = await deps.db.run(sql`delete from vault_folder_keys where folder_id = ${folderId} and user_id = ${userId} and org_id = ${a.orgId}`);
  if (!changes(r)) throw new HttpError(404, "not_found", "That person has no access to this folder.");
  await deps.db.run(sql`update vault_folders set needs_rotation = 1, updated_at = ${nowMs(deps)} where id = ${folderId} and org_id = ${a.orgId}`);
  await audit(deps, a, "revoke", { folderId });
  return { ok: true, needsRotation: true };
}

/**
 * Rotation: a new folder key made in the browser. Order keeps every item readable if it stops half way:
 * 1) new wrapped keys at a new version for exactly the current members, 2) every item re encrypted, 3) the folder's
 * version moves only when every item is on the new version, 4) old version keys are deleted.
 */
export async function rotateFolder(deps: Deps, a: VaultAuth, folderId: string, b: Body) {
  const { folder, access: acc } = await myAccess(deps, a, folderId);
  if (acc !== "manage") throw forbidden("Only folder managers can rotate the key.");
  if (b.fromVersion !== folder.key_version) throw new HttpError(409, "vault_stale", "The folder key changed. Reload and try again.");
  const maxRow = await deps.db.get<{ v: number }>(sql`select max(key_version) as v from vault_folder_keys where folder_id = ${folderId}`);
  const newVersion = Math.max(folder.key_version, Number(maxRow?.v ?? 0)) + 1;
  if (b.toVersion !== newVersion) throw new HttpError(409, "vault_stale", "The folder key changed. Reload and try again.", { toVersion: newVersion });
  const nameCt = b64u(b.nameCt, "Folder name", VAULT_MAX_NAME_CT, 20);
  const keys = keyInputs(b.keys, false);
  await dropLeavers(deps, a.orgId, folderId);
  const current = await deps.db.all<{ user_id: string; access: VaultAccess }>(sql`select user_id, access from vault_folder_keys where folder_id = ${folderId} and key_version = ${folder.key_version}`);
  const want = new Set(current.map((c) => c.user_id));
  if (keys.length !== want.size || keys.some((k) => !want.has(k.userId))) throw new HttpError(409, "vault_members_changed", "Who has access changed. Reload and try again.");
  const items = Array.isArray(b.items) ? (b.items as Body[]) : null;
  const have = await deps.db.all<{ id: string }>(sql`select id from vault_items where folder_id = ${folderId} and org_id = ${a.orgId}`);
  if (!items || items.length !== have.length || items.some((i) => !have.some((h) => h.id === i.id))) throw new HttpError(409, "vault_items_changed", "Items changed while rotating. Try again.");
  const cts = items.map((i) => ({ id: String(i.id), ct: b64u(i.ct, "Item", VAULT_MAX_ITEM_CT, 20) }));
  const accessOf = (u: string) => current.find((c) => c.user_id === u)?.access ?? "view";
  await insertKeys(deps, a.orgId, folderId, newVersion, a.userId, keys, accessOf);
  const now = nowMs(deps);
  for (const it of cts) {
    await deps.db.run(sql`update vault_items set ct = ${it.ct}, key_version = ${newVersion}, updated_at = ${now} where id = ${it.id} and folder_id = ${folderId}`);
  }
  const left = await deps.db.get<{ n: number }>(sql`select count(*) as n from vault_items where folder_id = ${folderId} and key_version <> ${newVersion}`);
  if (Number(left?.n ?? 0) > 0) throw new HttpError(409, "vault_items_changed", "Items changed while rotating. Try again.");
  const r = await deps.db.run(sql`update vault_folders set key_version = ${newVersion}, name_ct = ${nameCt}, needs_rotation = 0, updated_at = ${now}
    where id = ${folderId} and key_version = ${folder.key_version}`);
  if (!changes(r)) throw new HttpError(409, "vault_stale", "The folder key changed. Reload and try again.");
  await deps.db.run(sql`delete from vault_folder_keys where folder_id = ${folderId} and key_version <> ${newVersion}`);
  await audit(deps, a, "rotate", { folderId });
  return { keyVersion: newVersion };
}

// ---------------------------------------------------------------- items

export async function listItems(deps: Deps, a: VaultAuth, folderId: string): Promise<VaultItemDto[]> {
  await myAccess(deps, a, folderId);
  const rows = await deps.db.all<{ id: string; ct: string; key_version: number; updated_at: number; updated_by: string }>(sql`
    select id, ct, key_version, updated_at, updated_by from vault_items where folder_id = ${folderId} and org_id = ${a.orgId} order by created_at limit ${VAULT_MAX_ITEMS_PER_FOLDER}`);
  return rows.map((r) => ({ id: r.id, folderId, ct: r.ct, keyVersion: r.key_version, updatedAt: r.updated_at, updatedBy: r.updated_by }));
}

export async function saveItem(deps: Deps, a: VaultAuth, folderId: string, b: Body, itemId?: string) {
  const { folder, access: acc } = await myAccess(deps, a, folderId);
  if (!canEdit(acc)) throw forbidden("You can view this folder but not change it.");
  const id = itemId ?? (typeof b.id === "string" ? b.id : "");
  if (!VAULT_ITEM_ID.test(id)) throw badRequest("Item id is not valid.");
  const ct = b64u(b.ct, "Item", VAULT_MAX_ITEM_CT, 20);
  if (b.keyVersion !== folder.key_version) throw new HttpError(409, "vault_stale", "The folder key changed. Reload and try again.");
  const now = nowMs(deps);
  if (itemId) {
    const r = await deps.db.run(sql`update vault_items set ct = ${ct}, key_version = ${folder.key_version}, updated_by = ${a.userId}, updated_at = ${now}
      where id = ${id} and folder_id = ${folderId} and org_id = ${a.orgId}`);
    if (!changes(r)) throw new HttpError(404, "not_found", "Item not found.");
    await audit(deps, a, "item_update", { folderId, itemId: id });
  } else {
    const n = await deps.db.get<{ n: number }>(sql`select count(*) as n from vault_items where folder_id = ${folderId}`);
    if (Number(n?.n ?? 0) >= VAULT_MAX_ITEMS_PER_FOLDER) throw badRequest(`A folder can hold up to ${VAULT_MAX_ITEMS_PER_FOLDER} items.`);
    if (await deps.db.get(sql`select 1 as x from vault_items where id = ${id}`)) throw new HttpError(409, "exists", "That item already exists.");
    await deps.db.run(sql`insert into vault_items (id, org_id, folder_id, ct, key_version, created_by, updated_by, created_at, updated_at)
      values (${id}, ${a.orgId}, ${folderId}, ${ct}, ${folder.key_version}, ${a.userId}, ${a.userId}, ${now}, ${now})`);
    await audit(deps, a, "item_create", { folderId, itemId: id });
  }
  return { id, keyVersion: folder.key_version, updatedAt: now };
}

export async function deleteItem(deps: Deps, a: VaultAuth, folderId: string, itemId: string) {
  const { access: acc } = await myAccess(deps, a, folderId);
  if (!canEdit(acc)) throw forbidden("You can view this folder but not change it.");
  const r = await deps.db.run(sql`delete from vault_items where id = ${itemId} and folder_id = ${folderId} and org_id = ${a.orgId}`);
  if (!changes(r)) throw new HttpError(404, "not_found", "Item not found.");
  await audit(deps, a, "item_delete", { folderId, itemId });
  return { ok: true };
}

// ---------------------------------------------------------------- audit

/** The browser writes this BEFORE it shows or copies a secret field; no value is ever sent. */
export async function recordView(deps: Deps, a: VaultAuth, b: Body) {
  const action = b.action as string;
  if (!VAULT_CLIENT_ACTIONS.includes(action as (typeof VAULT_CLIENT_ACTIONS)[number])) throw badRequest("Action is not valid.");
  const field = VAULT_FIELDS.includes(b.field as (typeof VAULT_FIELDS)[number]) ? (b.field as string) : null;
  const folderId = String(b.folderId ?? "");
  const itemId = String(b.itemId ?? "");
  await myAccess(deps, a, folderId);
  if (!VAULT_ITEM_ID.test(itemId) || !(await deps.db.get(sql`select 1 as x from vault_items where id = ${itemId} and folder_id = ${folderId}`))) throw new HttpError(404, "not_found", "Item not found.");
  await audit(deps, a, action, { folderId, itemId, field });
  return { ok: true };
}

export async function listAudit(deps: Deps, a: VaultAuth, q: { before?: string; folderId?: string; userId?: string }) {
  if (!isAdmin(a)) throw forbidden("Only owners and admins can see the vault activity.");
  const before = Number(q.before) > 0 ? Number(q.before) : nowMs(deps) + 1;
  const rows = await deps.db.all<{ id: string; user_id: string; user_name: string; folder_id: string | null; item_id: string | null; action: string; field: string | null; at: number }>(sql`
    select id, user_id, user_name, folder_id, item_id, action, field, at from vault_audit where org_id = ${a.orgId} and at < ${before}
    ${q.folderId ? sql`and folder_id = ${q.folderId}` : sql``} ${q.userId ? sql`and user_id = ${q.userId}` : sql``}
    order by at desc limit 201`);
  const page = rows.slice(0, 200);
  return {
    rows: page.map((r) => ({ id: r.id, userId: r.user_id, userName: r.user_name, folderId: r.folder_id, itemId: r.item_id, action: r.action, field: r.field, at: r.at })),
    next: rows.length > 200 ? page[page.length - 1]!.at : null,
  };
}
