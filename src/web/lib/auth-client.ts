/** Better Auth's official client. Sign-in, sign-up, 2FA, sessions and social login go through it. */
import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";
import { ApiError } from "./api";

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
  try { res = await p; } catch { throw new ApiError(0, "network", "Can't reach MyMail. Check your connection."); }
  if (res.error) {
    const code = res.error.code ?? (res.error.status === 429 ? "TOO_MANY_REQUESTS" : "ERROR");
    throw new ApiError(res.error.status, code.toLowerCase(), FRIENDLY[code] ?? res.error.message ?? "Something went wrong.");
  }
  return res.data as T;
}
