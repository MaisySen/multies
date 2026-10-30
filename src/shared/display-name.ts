/**
 * R41 (MB-224): the name a greeting uses. A real profile name gives its first word. A name that is only the
 * email's local part (what a hosted sign up page hands over, for example "mymail.builder+qa3p55caab") is never
 * shown raw: the part before "+" is used only when it reads like a person's name, otherwise "" so the greeting
 * falls back to a plain "Good morning".
 */
const GENERIC = /(mail|info|admin|hello|contact|support|team|office|test|user|noreply|no-reply|sales|billing|builder|dev|ops|qa|bot|account|service)/i;

/** True when the name is empty, an email address, or just the email's local part (or something shaped like it). */
export function nameLooksLikeEmail(name: string | null | undefined, email?: string | null): boolean {
  const n = (name ?? "").trim();
  if (!n) return true;
  if (n.includes("@")) return true;
  const local = (email ?? "").split("@")[0]?.toLowerCase() ?? "";
  if (local && n.toLowerCase() === local) return true;
  // No space but a plus, a digit or a dot: a handle, not a name ("sam.lee", "qa3p55", "ops+x").
  return !/\s/.test(n) && /[+\d._]/.test(n);
}

function titleCase(word: string) {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** "Olive Owner" -> "Olive"; "olive.owner@x.com" as the name -> "Olive"; "mymail.builder+qa3" -> "". */
export function displayFirstName(name: string | null | undefined, email?: string | null): string {
  const n = (name ?? "").trim();
  if (!nameLooksLikeEmail(n, email)) return n.split(/\s+/)[0];
  const source = (n.includes("@") ? n : email || n).split("@")[0].split("+")[0];
  const first = source.replace(/\d+/g, "").split(/[._-]+/).filter(Boolean)[0] ?? "";
  if (!/^[a-z]{2,15}$/i.test(first) || GENERIC.test(source)) return "";
  return titleCase(first);
}
