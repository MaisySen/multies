/**
 * R128 Team password vault: limits and words shared by the server and the browser. The key model is in
 * files/catalogue/r128/DESIGN.md: PBKDF2 SHA-256 (600,000 rounds) then HKDF into a wrap key and an unlock proof,
 * RSA-OAEP 3072 key pairs per person, AES-GCM 256 keys per folder wrapped for each member, server keeps ciphertext only.
 */
export const VAULT_KDF_MIN_ITERATIONS = 600_000;
export const VAULT_KDF_ITERATIONS = 600_000;
export const VAULT_PASSPHRASE_MIN = 10;
export const VAULT_MAX_ITEM_CT = 65_536; // base64url chars of one encrypted item
export const VAULT_MAX_NAME_CT = 2_048;
export const VAULT_MAX_ITEMS_PER_FOLDER = 500;
export const VAULT_MAX_FOLDERS = 200;
export const VAULT_MAX_MEMBERS_PER_FOLDER = 100;
export const VAULT_LOCK_FAILS = 5; // wrong passphrases in a row before unlock pauses
export const VAULT_LOCK_BASE_MS = 15 * 60_000; // first pause; doubles each time, up to a day
export const VAULT_LOCK_MAX_MS = 24 * 60 * 60_000;
export const VAULT_AUTO_LOCK_CHOICES = [5, 15, 30, 60] as const; // minutes
export const VAULT_AUTO_LOCK_DEFAULT = 15;
export const VAULT_CLIPBOARD_CLEAR_MS = 30_000;

export const VAULT_ACCESS = ["view", "edit", "manage"] as const;
export type VaultAccess = (typeof VAULT_ACCESS)[number];
export const VAULT_ACCESS_LABEL: Record<VaultAccess, string> = { view: "Can view", edit: "Can edit", manage: "Can manage" };

/** Actions written by the browser before a secret is shown or copied (never with a value). */
export const VAULT_CLIENT_ACTIONS = ["reveal", "copy", "share"] as const;
export type VaultClientAction = (typeof VAULT_CLIENT_ACTIONS)[number];
export const VAULT_FIELDS = ["password", "username", "url", "notes", "custom"] as const;

export const VAULT_ACTION_LABEL: Record<string, string> = {
  reveal: "Revealed", copy: "Copied", share: "Shared securely", item_create: "Added item", item_update: "Edited item",
  item_delete: "Deleted item", folder_create: "Created folder", folder_rename: "Renamed folder", folder_delete: "Deleted folder", grant: "Gave access",
  access_change: "Changed access", revoke: "Removed access", rotate: "Rotated folder key", setup: "Set up vault", reset: "Reset vault",
  passphrase_change: "Changed passphrase", unlock_failed: "Wrong passphrase", locked_out: "Unlock paused",
};

/** Ids are made in the browser (they are bound into the encryption), so the server checks their shape. */
export const VAULT_FOLDER_ID = /^vf_[a-z0-9]{20}$/;
export const VAULT_ITEM_ID = /^vi_[a-z0-9]{20}$/;
export const B64U = /^[A-Za-z0-9_-]+$/;

/** How long unlock pauses after the n-th lockout (1 based). */
export function lockoutMs(lockouts: number): number {
  return Math.min(VAULT_LOCK_MAX_MS, VAULT_LOCK_BASE_MS * 2 ** Math.max(0, lockouts - 1));
}

export interface VaultFolderKeyDto { version: number; wrappedKey: string }
export interface VaultFolderDto {
  id: string; nameCt: string; keyVersion: number; needsRotation: boolean; access: VaultAccess; keys: VaultFolderKeyDto[]; itemCount: number; updatedAt: number;
}
export interface VaultItemDto { id: string; folderId: string; ct: string; keyVersion: number; updatedAt: number; updatedBy: string }
export interface VaultPersonDto { userId: string; name: string; email: string; role: "owner" | "admin" | "member"; publicKey: string | null; fingerprint: string | null }
export interface VaultStateDto {
  isAdmin: boolean; setUp: boolean; kdf: { salt: string; iterations: number } | null; fingerprint: string | null;
  lockedUntil: number | null; shareOn: boolean; userId: string; orgId: string;
}
