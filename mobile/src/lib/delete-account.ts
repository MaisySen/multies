import { ApiError } from "@/api/errors";

/** The word a person types to confirm, as the server checks it. */
export const CONFIRM_WORD = "DELETE";

export function confirmTyped(text: string): boolean {
  return text.trim() === CONFIRM_WORD;
}

/** A plain message for each way DELETE /api/account can fail. */
export function deleteAccountMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return "Something went wrong. Try again.";
  if (err.isNetwork) return "Can't reach MyMail. Check your connection and try again. Nothing was deleted.";
  switch (err.code) {
    case "confirm_required": return `Type ${CONFIRM_WORD} in capitals to confirm.`;
    case "password_required": return "Enter your password to confirm.";
    case "wrong_password": return "That password is incorrect. Nothing was deleted.";
    case "transfer_ownership_first": {
      const names = Array.isArray(err.details.workspaces) ? (err.details.workspaces as unknown[]).filter((w): w is string => typeof w === "string") : [];
      const which = names.length ? `${names.join(", ")} ${names.length === 1 ? "has" : "have"}` : "A workspace you own has";
      return `${which} other members. Make someone else an owner on the web first, or remove the other members, then try again.`;
    }
    case "unauthorized": return "Your session has ended. Sign in again, then delete your account.";
    case "too_many_requests": return err.message;
  }
  if (err.status >= 500) return "MyMail couldn't finish that just now. Try again in a minute, or contact support if it keeps failing.";
  return err.message;
}
