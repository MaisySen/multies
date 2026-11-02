/**
 * M1 (1.10.9): calendar and contacts sync (CalDAV and CardDAV) on the phone, as on the web's sync guide (flag davSync).
 * An app password is shown once when made; the list shows its name and dates, and any can be revoked.
 */
export interface AppPasswordView { id: string; name: string; createdAt: string; lastUsedAt?: string | null; [k: string]: unknown }
export interface AppPasswordList { passwords: AppPasswordView[]; server: string; username: string; max: number }
export interface CreatedAppPassword { password: string; item: AppPasswordView; server: string; username: string }

export const APP_PASSWORD_NAME_MAX = 60;
export type SyncGuide = "iphone" | "android";

/** The host part of the server address, for the by hand steps. */
export function hostOf(server: string): string {
  try { return new URL(server).host; } catch { return server.replace(/^https?:\/\//, "").replace(/\/.*$/, ""); }
}

export function guideSteps(g: SyncGuide, server: string): string[] {
  const host = hostOf(server);
  if (g === "iphone") {
    return [
      `Open Settings, Apps, Calendar, Calendar Accounts, Add Account, Other, Add CalDAV Account.`,
      `Server ${host}, your email as user name, the app password as password.`,
      `For contacts do the same under Settings, Apps, Contacts, Add CardDAV Account.`,
    ];
  }
  return [
    "Android has no built in CalDAV, so install a free CalDAV and CardDAV sync app from your app store.",
    "Add an account with a web address and user name. Paste the server address, your email and the app password.",
  ];
}

/** A name for a new app password: trimmed, never empty, within the server's 60 characters. */
export function passwordName(raw: string, fallback = "My phone"): string {
  const t = raw.trim().replace(/\s+/g, " ");
  return Array.from(t || fallback).slice(0, APP_PASSWORD_NAME_MAX).join("");
}
