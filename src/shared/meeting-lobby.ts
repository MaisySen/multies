/**
 * Round 32: the waiting room's shared words and clocks (server and web).
 */

/** The guest's lobby screen asks where its request stands at most this often. */
export const LOBBY_POLL_MS = 3000;
/** Members in a call look for waiting guests at most this often. */
export const LOBBY_HOST_POLL_MS = 4000;
/** The "So far" digest in the call dock refreshes at most this often. */
export const DOCK_SO_FAR_MS = 30_000;

/** "Maya is here", "Maya and Sam are here", "Maya and 2 others are here". */
export function hereText(names: string[], count = names.length): string {
  if (!count || !names.length) return "Nobody is here yet.";
  if (count === 1) return `${names[0]} is here.`;
  if (count === 2 && names.length >= 2) return `${names[0]} and ${names[1]} are here.`;
  const others = count - 1;
  return `${names[0]} and ${others} ${others === 1 ? "other is" : "others are"} here.`;
}

/** What a guest reads for each state of their request. */
export const LOBBY_COPY = {
  pending: "Waiting for the host to let you in",
  pendingBody: "You join as soon as someone in the meeting lets you in. Keep this page open.",
  denied: "The host didn't let you in to this meeting",
  deniedBody: "If you think this is a mistake, contact the person who invited you.",
  expired: "Your request timed out",
  expiredBody: "Nobody answered in 15 minutes. You can ask again.",
} as const;
