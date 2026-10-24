export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
  }
  get isNetwork() { return this.status === 0; }
}

const FRIENDLY: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "That email and password don't match.",
  INVALID_PASSWORD: "That password is incorrect.",
  INVALID_CODE: "That code didn't work. Check your authenticator app and try again.",
  INVALID_TWO_FACTOR_COOKIE: "Your sign in timed out. Start again.",
  INVALID_BACKUP_CODE: "That backup code didn't work, or it was already used.",
  TOO_MANY_REQUESTS: "Too many attempts. Wait a minute and try again.",
  EMAIL_NOT_VERIFIED: "Verify your email first. Check your inbox for the link.",
};

/**
 * Reads every error shape the API uses: the app's { error: { code, message } }, a bare
 * { error: "code", ...details } and Better Auth's { code, message }.
 */
export function toApiError(status: number, body: unknown): ApiError {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const e = raw.error;
  const nested = e && typeof e === "object" ? (e as { code?: string; message?: string }) : null;
  const bare = typeof e === "string" ? e : undefined;
  const code = nested?.code ?? bare ?? (typeof raw.code === "string" ? raw.code : undefined) ?? (status === 429 ? "TOO_MANY_REQUESTS" : "error");
  const message = FRIENDLY[code.toUpperCase()] ?? nested?.message ?? (typeof raw.message === "string" ? raw.message : undefined) ?? `Something went wrong (${status}).`;
  const details: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (k !== "error" && k !== "code" && k !== "message") details[k] = v;
  return new ApiError(status, code.toLowerCase(), message, details);
}

export const NETWORK_ERROR = () => new ApiError(0, "network", "Can't reach Multies. Check your connection.");
