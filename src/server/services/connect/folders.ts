/**
 * The provider's folders for a connected mailbox (round 19): list them, choose which of the
 * person's own folders sync (at most MAX_EXTRA_FOLDERS; Inbox, Sent, Archive, Drafts, Spam and Trash
 * always do), and the keys moves use. The list is read from the provider (one IMAP LIST) and kept in
 * the connection's sync state, so showing it again costs no database writes.
 */
import { eq } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { mailConnections } from "../../db/schema";
import { badRequest } from "../../lib/errors";
import { connectionFor, connectionSecret, imapConnector, type Connection } from ".";
import { pickFolders, type RemoteFolder } from "./imap";
import { classifyProblem, ConnectFailed } from "./problems";
import { FOLDER_LIST_TTL_MS, MAX_EXTRA_FOLDERS, parseState, syncedKeys, type SyncState } from "./sync";
import type { ConnectPresetId } from "@/shared/mail-connect";

export type FolderRole = "inbox" | "sent" | "archive" | "drafts" | "spam" | "trash";
export interface FolderView {
  /** What moves and lists use: a role for the standard folders, "f:<path>" for the person's own. */
  key: string;
  path: string;
  name: string;
  role: FolderRole | null;
  synced: boolean;
}

/** Reads the provider's folder list (one IMAP sign in). */
async function readList(deps: Deps, c: Connection): Promise<RemoteFolder[]> {
  const secret = await connectionSecret(deps, c);
  let session;
  try {
    session = await imapConnector(deps)({ host: c.imapHost, port: c.imapPort, security: c.imapSecurity }, { user: c.username, secret }, { allowSelfSigned: deps.config.mailConnect.allowSelfSigned });
  } catch (err) {
    throw new ConnectFailed(classifyProblem(err, "imap", c.provider as ConnectPresetId, c.imapHost));
  }
  try { return (await session.listFolders()).filter((f) => !f.noSelect); } finally { await session.close().catch(() => undefined); }
}

export function folderViews(state: SyncState): FolderView[] {
  const paths = state.paths ?? { inbox: "INBOX" };
  const roleOf = new Map<string, FolderRole>();
  for (const role of ["inbox", "sent", "archive", "drafts", "spam", "trash"] as const) { const p = paths[role]; if (p && !roleOf.has(p)) roleOf.set(p, role); }
  const synced = new Set(syncedKeys(state));
  const list = state.list?.length ? state.list : [{ path: paths.inbox, name: "Inbox" }];
  return list.map((f) => {
    const role = roleOf.get(f.path) ?? (f.path.toUpperCase() === "INBOX" ? "inbox" : null);
    const key = role ?? `f:${f.path}`;
    return { key, path: f.path, name: role === "inbox" ? "Inbox" : f.name, role, synced: synced.has(key as never) };
  }).sort((a, b) => (a.role ? 0 : 1) - (b.role ? 0 : 1) || a.path.localeCompare(b.path));
}

/** The provider's folders, read again when asked or when the kept list is old (one write when it changed). */
export async function listFolders(deps: Deps, auth: AuthContext, id: string, opts: { refresh?: boolean } = {}) {
  const c = await connectionFor(deps, auth, id, "read"); // PRIV1b (P14): the folder list signs in to the owner's account
  const state = parseState(c.syncState);
  const stale = !state.listedAt || deps.now().getTime() - state.listedAt > FOLDER_LIST_TTL_MS;
  if (opts.refresh || stale || !state.list?.length) {
    const list = await readList(deps, c);
    const changed = JSON.stringify(list) !== JSON.stringify(state.list ?? []);
    state.list = list;
    state.paths = { ...pickFolders(list), inbox: state.paths?.inbox ?? "INBOX" };
    state.listedAt = deps.now().getTime();
    // Folders gone at the provider stop syncing.
    state.extra = (state.extra ?? []).filter((p) => list.some((f) => f.path === p));
    if (changed || stale) await deps.db.update(mailConnections).set({ syncState: JSON.stringify(state) }).where(eq(mailConnections.id, c.id));
  }
  return { folders: folderViews(state), maxExtra: MAX_EXTRA_FOLDERS };
}

/** Turns syncing of one of the person's own folders on or off. Off keeps the mail already copied. */
export async function setFolderSync(deps: Deps, auth: AuthContext, id: string, path: string, on: boolean) {
  const c = await connectionFor(deps, auth, id, "run"); // PRIV1b (P14)
  const state = parseState(c.syncState);
  const view = folderViews(state).find((f) => f.path === path);
  if (!view) throw badRequest("That folder isn't at your provider. Refresh the list and try again.");
  if (view.role) throw badRequest(`${view.name} always syncs.`);
  const extra = new Set(state.extra ?? []);
  if (on) {
    if (!extra.has(path) && extra.size >= MAX_EXTRA_FOLDERS) throw badRequest(`Up to ${MAX_EXTRA_FOLDERS} of your own folders can sync. Turn one off first.`);
    extra.add(path);
  } else extra.delete(path);
  state.extra = [...extra];
  // Sync soon so the folder fills in.
  await deps.db.update(mailConnections).set({ syncState: JSON.stringify(state), nextSyncAt: deps.now() }).where(eq(mailConnections.id, c.id));
  return { folders: folderViews(state), maxExtra: MAX_EXTRA_FOLDERS };
}

/** Whether a folder key can be moved to for this connection (a standard folder the provider has, or a synced own folder). */
export function canMoveTo(state: SyncState, key: string) {
  if (key.startsWith("f:")) return (state.extra ?? []).includes(key.slice(2));
  return !!state.paths?.[key as keyof NonNullable<SyncState["paths"]>];
}
