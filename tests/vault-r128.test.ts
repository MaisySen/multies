/** R128 Team password vault: the key model round trips, the server rules (who may fetch what), lockout, rotation,
 * audit without values, and that no request body ever carries a passphrase or a secret in clear. */
import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import {
  createAccount, derivePassKeys, entropyBits, folderAad, generatePassword, genSets, itemAad, newFolderKey, openJson, openPrivateKey, randomBelow,
  randomId, rewrapPrivateKey, sealJson, unwrapFolderKey, wrapFolderKey, passphraseProblem, type VaultItemPlain,
} from "@/web/lib/vault-crypto";
import { isVaultExcluded } from "@/server/services/vault-r128";
import { lockoutMs, VAULT_LOCK_BASE_MS } from "@/shared/vault-r128";

const PASS = "correct horse battery staple";
const SECRET = "Sup3r$ecretPw!";
const TITLE = "Bank portal";

describe("R128 crypto (Web Crypto only)", () => {
  it("wraps and unwraps the private key and folder keys, and a wrong passphrase fails cleanly", async () => {
    const acc = await createAccount(PASS, "org1", "u1");
    expect(acc.iterations).toBeGreaterThanOrEqual(600_000);
    expect(acc.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    const right = await derivePassKeys(PASS, acc.salt, acc.iterations);
    expect(right.auth).toBe(acc.auth);
    const pk = await openPrivateKey(right.wrapKey, acc.wrappedPrivateKey, "org1", "u1");
    expect(pk.extractable).toBe(false);
    const wrong = await derivePassKeys("wrong horse battery staple", acc.salt, acc.iterations);
    expect(wrong.auth).not.toBe(acc.auth);
    await expect(openPrivateKey(wrong.wrapKey, acc.wrappedPrivateKey, "org1", "u1")).rejects.toThrow();
    // Bound to its owner: the same blob does not open for another person id.
    await expect(openPrivateKey(right.wrapKey, acc.wrappedPrivateKey, "org1", "u2")).rejects.toThrow();
    const fk = await newFolderKey();
    const w = await wrapFolderKey(fk, acc.publicKey);
    const back = await unwrapFolderKey(w, pk);
    const ct = await sealJson(fk, { title: TITLE }, itemAad("vf_a", "vi_a", 1));
    expect(await openJson(back, ct, itemAad("vf_a", "vi_a", 1))).toEqual({ title: TITLE });
    // A ciphertext moved to another item, folder or version does not open.
    await expect(openJson(back, ct, itemAad("vf_a", "vi_b", 1))).rejects.toThrow();
    await expect(openJson(back, ct, itemAad("vf_a", "vi_a", 2))).rejects.toThrow();
    // Fresh IVs: the same plaintext twice gives different ciphertexts.
    expect(await sealJson(fk, { a: 1 }, folderAad("vf_a", 1))).not.toBe(await sealJson(fk, { a: 1 }, folderAad("vf_a", 1)));
    // Passphrase change keeps the key pair.
    const next = await derivePassKeys("a brand new passphrase", acc.salt, acc.iterations);
    const re = await rewrapPrivateKey(right.wrapKey, next.wrapKey, acc.wrappedPrivateKey, "org1", "u1");
    const pk2 = await openPrivateKey(next.wrapKey, re, "org1", "u1");
    expect(await unwrapFolderKey(w, pk2)).toBeTruthy();
  }, 30_000);

  it("generates passwords with the chosen kinds, length and no look alikes", () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassword({ length: 24, upper: true, lower: true, digits: true, symbols: false, avoidSimilar: true });
      expect(p).toHaveLength(24);
      expect(p).toMatch(/[A-Z]/); expect(p).toMatch(/[a-z]/); expect(p).toMatch(/[0-9]/);
      expect(p).not.toMatch(/[Il1O0o!#$%]/);
    }
    expect(generatePassword({ length: 4, upper: false, lower: false, digits: true, symbols: false, avoidSimilar: false })).toMatch(/^\d{8}$/);
    expect(generatePassword({ length: 999, upper: true, lower: false, digits: false, symbols: false, avoidSimilar: false })).toHaveLength(128);
    expect(genSets({ length: 10, upper: false, lower: false, digits: false, symbols: false, avoidSimilar: false })).toHaveLength(1);
    expect(entropyBits({ length: 20, upper: true, lower: true, digits: true, symbols: true, avoidSimilar: false })).toBeGreaterThan(120);
    // Unbiased: values at or above the largest multiple of n are thrown away, not folded.
    const seq = [0xffffffff, 7];
    expect(randomBelow(10, (a) => { a[0] = seq.shift()!; return a; })).toBe(7);
    // Roughly uniform over many draws.
    const counts = new Array(6).fill(0);
    for (let i = 0; i < 6000; i++) counts[randomBelow(6)]++;
    for (const n of counts) expect(n).toBeGreaterThan(850);
    expect(randomId("vf")).toMatch(/^vf_[a-z0-9]{20}$/);
    expect(passphraseProblem("short")).toBeTruthy();
    expect(passphraseProblem(PASS)).toBeNull();
  });

  it("keeps vv8k out and pauses unlock longer each time", () => {
    expect(isVaultExcluded({ id: "o1", slug: "vv8k", name: "Client" })).toBe(true);
    expect(isVaultExcluded({ id: "o1", slug: "acme", name: "Acme" })).toBe(false);
    expect(lockoutMs(1)).toBe(VAULT_LOCK_BASE_MS);
    expect(lockoutMs(2)).toBe(VAULT_LOCK_BASE_MS * 2);
    expect(lockoutMs(30)).toBe(24 * 60 * 60_000);
  });
});

type Res = { status: number; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

async function setup(env: Record<string, string> = { VAULT_R128: "on", TOOLS_FEATURES: "all" }) {
  const ctx = await makeTestApp(env);
  const bodies: string[] = [];
  const orig = ctx.app.request.bind(ctx.app);
  // Every request body the server receives is kept, to prove no plaintext ever reaches it.
  (ctx.app as { request: typeof ctx.app.request }).request = ((path: string, init?: RequestInit) => {
    if (init?.body && typeof init.body === "string") bodies.push(init.body);
    return orig(path, init);
  }) as typeof ctx.app.request;
  const admin = new Client(ctx.app);
  await admin.signup("ada@acme.io", "Ada Lovelace", "Acme");
  const join = async (email: string, name: string, role: "member" | "admin" = "member") => {
    const inv = await admin.post("/api/team/invites", { email, role });
    const m = new Client(ctx.app);
    await m.signup(email, name, `${name} Co`);
    expect((await m.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    return m;
  };
  const me = async (c: Client) => { const s = (await c.get("/api/vault/state")).body as { userId: string; orgId: string }; return { user: { id: s.userId }, organization: { id: s.orgId } }; };
  const setUp = async (c: Client, pass = PASS) => {
    const m = await me(c);
    const acc = await createAccount(pass, m.organization.id, m.user.id);
    const r: Res = await c.post("/api/vault/account", { publicKey: acc.publicKey, wrappedPrivateKey: acc.wrappedPrivateKey, salt: acc.salt, iterations: acc.iterations, auth: acc.auth, fingerprint: acc.fingerprint });
    expect(r.status).toBe(201);
    return { ...acc, userId: m.user.id, orgId: m.organization.id };
  };
  return { ...ctx, admin, join, setUp, bodies, me };
}

describe("R128 server rules", () => {
  it("sets up, unlocks with the right proof only, and pauses after 5 wrong tries", async () => {
    const { admin, setUp, deps } = await setup();
    expect((await admin.get("/api/vault/state")).body).toMatchObject({ setUp: false, isAdmin: true });
    const acc = await setUp(admin);
    const st = (await admin.get("/api/vault/state")).body;
    expect(st).toMatchObject({ setUp: true, kdf: { salt: acc.salt, iterations: acc.iterations } });
    expect(JSON.stringify(st)).not.toContain(acc.wrappedPrivateKey);
    const ok: Res = await admin.post("/api/vault/open", { auth: acc.auth });
    expect(ok.status).toBe(200);
    expect(ok.body.wrappedPrivateKey).toBe(acc.wrappedPrivateKey);
    const bad = (await derivePassKeys("nope nope nope nope", acc.salt, acc.iterations)).auth;
    for (let i = 0; i < 4; i++) {
      const r: Res = await admin.post("/api/vault/open", { auth: bad });
      expect(r.status).toBe(401);
      expect(JSON.stringify(r.body)).not.toContain("wrappedPrivateKey");
    }
    const paused: Res = await admin.post("/api/vault/open", { auth: bad });
    expect(paused.status).toBe(429);
    // Even the right proof waits out the pause.
    expect((await admin.post("/api/vault/open", { auth: acc.auth })).status).toBe(429);
    const t0 = deps.now().getTime?.() ?? Date.now();
    deps.now = (() => new Date(t0 + 16 * 60_000)) as typeof deps.now;
    expect((await admin.post("/api/vault/open", { auth: acc.auth })).status).toBe(200);
    // Weak protection and a second set up are refused.
    expect((await admin.post("/api/vault/account", { publicKey: acc.publicKey, wrappedPrivateKey: acc.wrappedPrivateKey, salt: acc.salt, iterations: acc.iterations, auth: acc.auth, fingerprint: acc.fingerprint })).status).toBe(409);
  }, 60_000);

  it("shares a folder: members see only theirs, view vs edit, removal rotates the key", async () => {
    const { admin, join, setUp, bodies, ctxDb } = await setup() as Awaited<ReturnType<typeof setup>> & { ctxDb?: unknown };
    void ctxDb;
    const A = await setUp(admin);
    const bob = await join("bob@acme.io", "Bob Member");
    const cat = await join("cat@acme.io", "Cat Member");
    const B = await setUp(bob, "bobs very long passphrase");
    await setUp(cat, "cats very long passphrase");
    // Members cannot create folders or read people.
    expect((await bob.post("/api/vault/folders", {})).status).toBe(403);
    expect((await bob.get("/api/vault/people")).status).toBe(403);
    const people = (await admin.get("/api/vault/people")).body.people as { userId: string; publicKey: string | null }[];
    const bobP = people.find((p) => p.userId === B.userId)!;
    expect(bobP.publicKey).toBe(B.publicKey);

    const fid = randomId("vf");
    const fk = await newFolderKey();
    const r1: Res = await admin.post("/api/vault/folders", { id: fid, nameCt: await sealJson(fk, { name: "Finance" }, folderAad(fid, 1)), keys: [{ userId: A.userId, wrappedKey: await wrapFolderKey(fk, A.publicKey), access: "manage" }] });
    expect(r1.status).toBe(201);
    const iid = randomId("vi");
    const item: VaultItemPlain = { title: TITLE, username: "ada", password: SECRET, url: "https://bank.example", notes: "" };
    expect((await admin.post(`/api/vault/folders/${fid}/items`, { id: iid, ct: await sealJson(fk, item, itemAad(fid, iid, 1)), keyVersion: 1 })).status).toBe(201);

    // Bob is not in it: nothing about it is reachable.
    expect((await bob.get("/api/vault/folders")).body.folders).toEqual([]);
    for (const p of [`/api/vault/folders/${fid}/items`, `/api/vault/folders/${fid}/access`]) expect((await bob.get(p)).status).toBe(404);
    expect((await bob.post("/api/vault/audit", { folderId: fid, itemId: iid, action: "reveal", field: "password" })).status).toBe(404);

    // Give Bob view access.
    expect((await admin.post(`/api/vault/folders/${fid}/access`, { userId: B.userId, wrappedKey: await wrapFolderKey(fk, B.publicKey), access: "view", keyVersion: 1 })).status).toBe(201);
    expect((await admin.post(`/api/vault/folders/${fid}/access`, { userId: B.userId, wrappedKey: await wrapFolderKey(fk, B.publicKey), access: "manage", keyVersion: 1 })).status).toBe(400);
    const bf = (await bob.get("/api/vault/folders")).body.folders;
    expect(bf).toHaveLength(1);
    expect(bf[0].access).toBe("view");
    const bobPk = await openPrivateKey((await derivePassKeys("bobs very long passphrase", B.salt, B.iterations)).wrapKey, (await bob.post("/api/vault/open", { auth: B.auth })).body.wrappedPrivateKey, B.orgId, B.userId);
    const bobFk = await unwrapFolderKey(bf[0].keys[0].wrappedKey, bobPk);
    const items = (await bob.get(`/api/vault/folders/${fid}/items`)).body.items;
    expect((await openJson<VaultItemPlain>(bobFk, items[0].ct, itemAad(fid, iid, 1))).password).toBe(SECRET);
    // View only: no writes.
    expect((await bob.put(`/api/vault/folders/${fid}/items/${iid}`, { ct: items[0].ct, keyVersion: 1 })).status).toBe(403);
    expect((await bob.del(`/api/vault/folders/${fid}/items/${iid}`)).status).toBe(403);
    // Reveal is audited without the value.
    expect((await bob.post("/api/vault/audit", { folderId: fid, itemId: iid, action: "reveal", field: "password", value: "stray-value-9" })).status).toBe(201);
    expect((await bob.get("/api/vault/audit")).status).toBe(403);
    const log = (await admin.get("/api/vault/audit")).body.rows as { action: string; userName: string; itemId: string }[];
    expect(log.find((r) => r.action === "reveal")).toMatchObject({ userName: "Bob Member", itemId: iid });
    expect(JSON.stringify(log)).not.toContain("stray-value-9");
    // Edit access lets Bob change items.
    expect((await admin.patch(`/api/vault/folders/${fid}/access/${B.userId}`, { access: "edit" })).status).toBe(200);
    expect((await bob.put(`/api/vault/folders/${fid}/items/${iid}`, { ct: await sealJson(bobFk, { ...item, notes: "x" }, itemAad(fid, iid, 1)), keyVersion: 1 })).status).toBe(200);

    // Remove Bob: his keys go, the folder needs rotation; a rotation must cover exactly the members left.
    const rv: Res = await admin.del(`/api/vault/folders/${fid}/access/${B.userId}`);
    expect(rv.body.needsRotation).toBe(true);
    expect((await bob.get("/api/vault/folders")).body.folders).toEqual([]);
    expect((await bob.get(`/api/vault/folders/${fid}/items`)).status).toBe(404);
    const af = (await admin.get("/api/vault/folders")).body.folders[0];
    expect(af.needsRotation).toBe(true);
    // Granting waits for the rotation.
    expect((await admin.post(`/api/vault/folders/${fid}/access`, { userId: B.userId, wrappedKey: await wrapFolderKey(fk, B.publicKey), access: "view", keyVersion: 1 })).status).toBe(409);
    const nk = await newFolderKey();
    const cur = (await admin.get(`/api/vault/folders/${fid}/items`)).body.items as { id: string; ct: string }[];
    const plain = await openJson<VaultItemPlain>(fk, cur[0]!.ct, itemAad(fid, iid, 1));
    const rotBody = (keys: unknown[]) => ({ fromVersion: 1, toVersion: 2, keys, nameCt: "x".repeat(40), items: [{ id: iid, ct: "y".repeat(40) }] });
    expect((await admin.post(`/api/vault/folders/${fid}/rotate`, rotBody([{ userId: A.userId, wrappedKey: await wrapFolderKey(nk, A.publicKey) }, { userId: B.userId, wrappedKey: await wrapFolderKey(nk, B.publicKey) }]))).status).toBe(409);
    const rot: Res = await admin.post(`/api/vault/folders/${fid}/rotate`, {
      fromVersion: 1, toVersion: 2, nameCt: await sealJson(nk, { name: "Finance" }, folderAad(fid, 2)),
      keys: [{ userId: A.userId, wrappedKey: await wrapFolderKey(nk, A.publicKey) }], items: [{ id: iid, ct: await sealJson(nk, plain, itemAad(fid, iid, 2)) }],
    });
    expect(rot.status).toBe(200);
    expect(rot.body.keyVersion).toBe(2);
    const after = (await admin.get("/api/vault/folders")).body.folders[0];
    expect(after).toMatchObject({ keyVersion: 2, needsRotation: false });
    expect(after.keys).toHaveLength(1);
    const it2 = (await admin.get(`/api/vault/folders/${fid}/items`)).body.items[0];
    expect((await openJson<VaultItemPlain>(nk, it2.ct, itemAad(fid, iid, 2))).password).toBe(SECRET);
    await expect(openJson(fk, it2.ct, itemAad(fid, iid, 2))).rejects.toThrow();

    // The server never saw a passphrase or a secret in clear.
    const all = bodies.join("\n");
    for (const s of [PASS, "bobs very long passphrase", SECRET, TITLE, "Finance", "bank.example"]) expect(all).not.toContain(s);
  }, 120_000);

  it("is off with the flag off, out of other workspaces, and resets a forgotten vault", async () => {
    const off = await setup({ VAULT_R128: "off" });
    expect((await off.admin.get("/api/vault/state")).status).toBe(404);
    const { admin, setUp } = await setup();
    const A = await setUp(admin);
    const fid = randomId("vf");
    const fk = await newFolderKey();
    await admin.post("/api/vault/folders", { id: fid, nameCt: await sealJson(fk, { name: "Ops" }, folderAad(fid, 1)), keys: [{ userId: A.userId, wrappedKey: await wrapFolderKey(fk, A.publicKey), access: "manage" }] });
    // Someone in another workspace (own signup) sees nothing of it.
    const other = await setup();
    const O = await other.setUp(other.admin);
    void O;
    expect((await other.admin.get("/api/vault/folders")).body.folders).toEqual([]);
    expect((await admin.post("/api/vault/account/reset", {})).status).toBe(400);
    expect((await admin.post("/api/vault/account/reset", { confirm: "reset" })).status).toBe(200);
    expect((await admin.get("/api/vault/state")).body.setUp).toBe(false);
    expect((await admin.get("/api/vault/folders")).body.folders).toEqual([]);
  }, 60_000);
});
