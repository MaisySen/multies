export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
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

/** Reads both error shapes: the app's { error: { code, message } } and Better Auth's { code, message }. */
export function toApiError(status: number, body: unknown): ApiError {
  const b = (body ?? {}) as { error?: { code?: string; message?: string }; code?: string; message?: string };
  const code = b.error?.code ?? b.code ?? (status === 429 ? "TOO_MANY_REQUESTS" : "error");
  const message = FRIENDLY[code.toUpperCase()] ?? b.error?.message ?? b.message ?? `Something went wrong (${status}).`;
  return new ApiError(status, code.toLowerCase(), message);
}

export const NETWORK_ERROR = () => new ApiError(0, "network", "Can't reach MyMail. Check your connection.");
