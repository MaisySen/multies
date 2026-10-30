/**
 * R56 (MB-241, MB-248): a first name to greet someone with, or to name their workspace and suggest
 * their free address after. Never the raw sign in email: a plus tag ("name+tag@") or a dotted handle
 * ("sammy.tester") is not a name, so only the first word with letters in the email's local part is used.
 */

/** "sammy.tester+qa4@x.com" becomes "Sammy"; "ada_lovelace99@x.com" becomes "Ada". Empty when nothing usable. */
export function nameFromEmail(email: string): string {
  const local = (email.split("@")[0] ?? "").split("+")[0] ?? "";
  const word = local.split(/[._\-\d]+/).find((p) => /[a-z]/i.test(p)) ?? "";
  const clean = word.replace(/[^\p{L}]/gu, "").slice(0, 20);
  return clean ? clean[0]!.toUpperCase() + clean.slice(1).toLowerCase() : "";
}

/** The first word of the person's name, or a name from their email when the name is missing or is itself an email. */
export function firstNameGuess(name: string | null | undefined, email = ""): string {
  const n = (name ?? "").trim();
  if (n && !n.includes("@")) return (n.split(/\s+/)[0] ?? "").slice(0, 40);
  return nameFromEmail(n.includes("@") ? n : email) || nameFromEmail(email);
}

/** The name a new workspace starts with before the person tells us their company. */
export const autoWorkspaceName = (name: string | null | undefined, email = "") => `${firstNameGuess(name, email) || "My"}'s workspace`;
