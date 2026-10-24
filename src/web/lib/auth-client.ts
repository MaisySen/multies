/** Better Auth's official client. Sign-in, sign-up, 2FA, sessions and social login go through it. */
import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";
import { ApiError } from "./api";
import { markReadOnly, READ_ONLY_MESSAGE } from "./read-only";

export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [twoFactorClient()],
});

const FRIENDLY: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "That email and password don't match.",
  USER_ALREADY_EXISTS: "An account with this email already exists. Sign in instead.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "An account with this email already exists. Sign in instead.",
  PASSWORD_TOO_SHORT: "Use at least 10 characters.",
  INVALID_PASSWORD: "That password is incorrect.",
  INVALID_CODE: "That code didn't work. Check your authenticator app and try again.",
  INVALID_BACKUP_CODE: "That backup code didn't work, or it was already used.",
  INVALID_TOKEN: "This link is invalid or has expired. Ask for a new one.",
  TOO_MANY_REQUESTS: "Too many attempts. Wait a minute and try again.",
};

/** Unwraps a Better Auth client result, throwing an ApiError with a readable message. */
export async function unwrap<T>(p: Promise<{ data: T | null; error: { status: number; code?: string; message?: string } | null }>): Promise<T> {
  let res;
  try { res = await p; } catch { throw new ApiError(0, "network", "Can't reach Multies. Check your connection."); }
  // The app's own error shape ({ error: { code, message } }), e.g. read only when the database's daily write limit is reached.
  const own = (res.error as { error?: { code?: string; message?: string } } | null)?.error;
  if (res.error && own?.code === "read_only") {
    markReadOnly();
    throw new ApiError(res.error.status, "read_only", READ_ONLY_MESSAGE);
  }
  if (res.error) {
    const code = res.error.code ?? (res.error.status === 429 ? "TOO_MANY_REQUESTS" : "ERROR");
    throw new ApiError(res.error.status, code.toLowerCase(), FRIENDLY[code] ?? res.error.message ?? "Something went wrong.");
  }
  return res.data as T;
}

/** What this deployment offers: the identity provider (one sign in and sign up page) and/or the password form. */
export interface AuthProviders { idp: boolean; password: boolean; google: boolean; github: boolean }

/**
 * Ends the app session, then the identity provider's session too when it is on, so the next
 * person at this browser sees the sign in page instead of being let straight back in.
 */
export async function signOutEverywhere(opts: { idp?: boolean } = {}): Promise<"redirected" | "done"> {
  try { await authClient.signOut(); } catch { /* already signed out */ }
  if (opts.idp) {
    window.location.assign("/api/auth/logout/idp");
    return "redirected";
  }
  return "done";
}
