/**
 * R89: docs visual, the parts both the server and the web read. A whiteboard doc is a doc whose content is one
 * whiteboard block with page set; the server keeps docs.kind in step with that on every write, so lists and the
 * page tree know which icon to show without reading the content.
 */
interface Node { type?: string; attrs?: Record<string, unknown>; content?: Node[] }

export type DocKind = "doc" | "whiteboard";

export function docKindOf(content: unknown): DocKind {
  const blocks = ((content as Node | null)?.content ?? []).filter((b) => !(b.type === "paragraph" && !b.content?.length));
  return blocks.length === 1 && blocks[0].type === "whiteboard" && blocks[0].attrs?.page === true ? "whiteboard" : "doc";
}

/** The words on a saved board (text elements), one per line, for search and for agents. */
export function boardTextOf(scene: unknown): string {
  let list: unknown;
  try { list = typeof scene === "string" ? JSON.parse(scene || "[]") : scene; } catch { return ""; }
  if (!Array.isArray(list)) return "";
  return list
    .filter((e) => e && typeof e === "object" && (e as { type?: unknown }).type === "text" && !(e as { isDeleted?: unknown }).isDeleted && typeof (e as { text?: unknown }).text === "string")
    .map((e) => String((e as { text: string }).text).trim())
    .filter(Boolean)
    .join("\n");
}

/** A whiteboard doc's content: one page sized board, empty or with the given elements (as JSON). */
export function whiteboardDocContent(scene = "[]", id = "board") {
  return { type: "doc", content: [{ type: "whiteboard", attrs: { id, scene, page: true, height: 420 } }] };
}
