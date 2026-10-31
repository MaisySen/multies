/**
 * R89: whiteboard live merge. Each board keeps its drawing in a shared map with one entry per element, so two
 * people drawing at once edit different entries and nothing is lost. When the same element changes on both
 * sides, the higher version wins and a tie goes to the lower versionNonce (the drawing library's own rule), so
 * every client settles on the same picture. Pure, so it is unit tested without a canvas.
 */
export interface BoardElement { id: string; version: number; versionNonce: number; index?: string | null; isDeleted?: boolean; [k: string]: unknown }

/** True when b should replace a. */
export function wins(a: BoardElement | undefined, b: BoardElement): boolean {
  if (!a) return true;
  if (b.version !== a.version) return b.version > a.version;
  return b.versionNonce < a.versionNonce;
}

/** One list from two, element by element, in drawing order (fractional index, then id). */
export function mergeElements(local: readonly BoardElement[], remote: readonly BoardElement[]): BoardElement[] {
  const byId = new Map<string, BoardElement>();
  for (const e of local) byId.set(e.id, e);
  for (const e of remote) if (wins(byId.get(e.id), e)) byId.set(e.id, e);
  return orderElements([...byId.values()]);
}

export function orderElements(list: BoardElement[]): BoardElement[] {
  return [...list].sort((a, b) => {
    const ai = a.index ?? "", bi = b.index ?? "";
    if (ai !== bi) return ai < bi ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Elements whose version differs from what was last sent (new, changed or deleted). */
export function changedSince(sent: Map<string, number>, elements: readonly BoardElement[]): BoardElement[] {
  return elements.filter((e) => sent.get(e.id) !== e.version);
}

/** A cheap fingerprint of a scene: changes whenever any element's version does. */
export function sceneKey(elements: readonly BoardElement[]): string {
  let h = 0;
  for (const e of elements) {
    const s = `${e.id}:${e.version}`;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return `${elements.length}:${h >>> 0}`;
}

/** Elements worth keeping in the saved copy: deleted ones older than a day are dropped. */
export function snapshotElements(elements: readonly BoardElement[], now = Date.now()): BoardElement[] {
  return elements.filter((e) => !e.isDeleted || (typeof e.updated === "number" && now - e.updated < 86_400_000));
}

export const MAX_BOARD_BYTES = 1_500_000;

/** The text on a board (for search and agents), one element per line. */
export function boardText(elements: readonly BoardElement[]): string {
  return elements.filter((e) => !e.isDeleted && e.type === "text" && typeof e.text === "string").map((e) => String(e.text).trim()).filter(Boolean).join("\n");
}

/** Parses a saved scene attr into elements; anything unreadable is an empty board. */
export function readScene(scene: unknown): BoardElement[] {
  try {
    const v = typeof scene === "string" ? JSON.parse(scene || "[]") : scene;
    const list = Array.isArray(v) ? v : Array.isArray((v as { elements?: unknown })?.elements) ? (v as { elements: unknown[] }).elements : [];
    return list.filter((e): e is BoardElement => !!e && typeof e === "object" && typeof (e as BoardElement).id === "string" && typeof (e as BoardElement).version === "number");
  } catch {
    return [];
  }
}
