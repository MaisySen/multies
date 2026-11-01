/**
 * R128 vault: the decrypted view model, kept in memory only while the vault is open (react query cache, cleared on lock).
 * Query keys carry ids only; no value ever goes into a key, a URL or an error message.
 */
import { api } from "@/web/lib/api";
import { folderKey } from "@/web/lib/vault-session";
import { folderAad, itemAad, openJson, sealJson, type VaultFolderPlain, type VaultItemPlain } from "@/web/lib/vault-crypto";
import type { VaultAccess, VaultFolderDto, VaultItemDto, VaultStateDto } from "@/shared/vault-r128";

export interface DecFolder { id: string; name: string | null; access: VaultAccess; keyVersion: number; needsRotation: boolean; itemCount: number; keys: VaultFolderDto["keys"] }
export interface DecItem { id: string; folderId: string; keyVersion: number; updatedAt: number; plain: VaultItemPlain | null }

export const vk = {
  state: ["vault", "state"] as const,
  folders: ["vault", "folders"] as const,
  items: (folderId: string) => ["vault", "items", folderId] as const,
  people: ["vault", "people"] as const,
  access: (folderId: string) => ["vault", "access", folderId] as const,
  audit: ["vault", "audit"] as const,
};

export const getState = () => api.get<VaultStateDto>("/vault/state");

const keyFor = (f: { id: string; keys: VaultFolderDto["keys"] }, version: number) => {
  const k = f.keys.find((x) => x.version === version);
  if (!k) throw new Error("no key");
  return folderKey(f.id, version, k.wrappedKey);
};
export const currentKey = (f: DecFolder) => keyFor(f, f.keyVersion);

export async function loadFolders(): Promise<DecFolder[]> {
  const { folders } = await api.get<{ folders: VaultFolderDto[] }>("/vault/folders");
  const out = await Promise.all(folders.map(async (f) => {
    let name: string | null;
    try { name = (await openJson<VaultFolderPlain>(await keyFor(f, f.keyVersion), f.nameCt, folderAad(f.id, f.keyVersion))).name; } catch { name = null; }
    return { id: f.id, name, access: f.access, keyVersion: f.keyVersion, needsRotation: f.needsRotation, itemCount: f.itemCount, keys: f.keys };
  }));
  return out.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", undefined, { sensitivity: "base" }));
}

export async function loadItems(f: DecFolder): Promise<DecItem[]> {
  const { items } = await api.get<{ items: VaultItemDto[] }>(`/vault/folders/${f.id}/items`);
  return Promise.all(items.map(async (i) => {
    let plain: VaultItemPlain | null;
    try { plain = await openJson<VaultItemPlain>(await keyFor(f, i.keyVersion), i.ct, itemAad(f.id, i.id, i.keyVersion)); } catch { plain = null; }
    return { id: i.id, folderId: f.id, keyVersion: i.keyVersion, updatedAt: i.updatedAt, plain };
  }));
}

export const sealItem = async (f: DecFolder, itemId: string, plain: VaultItemPlain) => sealJson(await currentKey(f), plain, itemAad(f.id, itemId, f.keyVersion));
export const sealFolderName = (key: CryptoKey, folderId: string, version: number, name: string) => sealJson(key, { name } satisfies VaultFolderPlain, folderAad(folderId, version));

/** Writes the audit row first; the caller shows or copies only if this resolved. */
export const auditView = (folderId: string, itemId: string, action: "reveal" | "copy" | "share", field: string) =>
  api.post("/vault/audit", { folderId, itemId, action, field });

export const canEdit = (a: VaultAccess) => a === "edit" || a === "manage";
export const blankItem = (): VaultItemPlain => ({ title: "", username: "", password: "", url: "", notes: "" });

/** A CSV cell that spreadsheets will not run as a formula. */
export function csvCell(v: string): string {
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** Only http and https links open (a stored "javascript:" never runs). */
export function safeUrl(u: string): string | null {
  try { const x = new URL(/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`); return x.protocol === "https:" || x.protocol === "http:" ? x.href : null; } catch { return null; }
}
