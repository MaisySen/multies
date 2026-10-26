/**
 * Round 24: the pure decisions behind live co-editing, shared by the doc page and the
 * meeting notes. Kept free of the browser so they can be unit tested.
 */

/** The editor mode for a room: live when the socket synced, else the single editor that saves through REST. */
export type CollabMode = "live" | "solo";
export const collabMode = (session: unknown): CollabMode => (session ? "live" : "solo");

/** Lowest connected client id saves the doc row. The local client counts even before its presence arrives. */
export function leaderOf(localId: number, connectedIds: Iterable<number>): boolean {
  const ids = [...connectedIds];
  if (!ids.includes(localId)) ids.push(localId);
  return Math.min(...ids) === localId;
}

/**
 * What a live client does when its save timer fires: only the leader writes, and only
 * when the content hash moved since the last save (or a title patch rides along).
 */
export function liveSaveStep(opts: { leader: boolean; hash: string; savedHash: unknown; titlePatch?: boolean }): "skip" | "save" {
  if (!opts.leader) return "skip";
  if (opts.hash === opts.savedHash && !opts.titlePatch) return "skip";
  return "save";
}

/** "Maya is editing", "Maya and Ben are editing", "Maya, Ben and 2 others are editing". */
export function editingLabel(names: string[]): string {
  const first = names.map((n) => n.trim().split(/\s+/)[0] || "Someone");
  if (first.length === 0) return "Only you are here";
  if (first.length === 1) return `${first[0]} is editing`;
  if (first.length === 2) return `${first[0]} and ${first[1]} are editing`;
  if (first.length === 3) return `${first[0]}, ${first[1]} and ${first[2]} are editing`;
  return `${first[0]}, ${first[1]} and ${first.length - 2} others are editing`;
}

/** One or two letters for a small avatar. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/[\s@._-]+/).filter(Boolean);
  if (!parts.length) return "?";
  const a = parts[0][0] ?? "";
  const b = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "";
  return (a + b).toUpperCase();
}

/**
 * R29: whether an editor update means "Unsaved changes" for this person. Only their own typing
 * does. In a live session a change that came from the room (the shared doc's first render, the
 * editor's normalisation of it such as the closing empty paragraph, another person's typing) is
 * saved quietly by the leader when it differs from the row, so opening a doc no longer flashes
 * "Unsaved changes".
 */
export function updateShowsUnsaved(opts: { live: boolean; fromRoom: boolean }): boolean {
  return !(opts.live && opts.fromRoom);
}
