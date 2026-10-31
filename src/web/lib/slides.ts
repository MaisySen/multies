/**
 * R89: Present. A doc split into slides at its H1 and H2 headings.
 *
 * Slide one is the title slide (the doc title, with the first short paragraph before any heading as its line).
 * Anything else before the first heading becomes a slide of its own. A callout whose text starts with "Notes"
 * inside a slide is taken out of the slide and becomes that slide's speaker notes. A doc with no H1 or H2 gives
 * the title slide and one slide with the whole doc.
 */
import { inlineText, type PMNode } from "./mindmap-tree";

export interface Slide {
  kind: "title" | "content";
  title: string;
  /** The heading's inline content (marks kept) for content slides. */
  heading?: PMNode | null;
  subtitle?: string;
  blocks: PMNode[];
  notes: string;
}

const NOTES = /^\s*(speaker\s+)?notes?\b\s*[:.]?\s*/i;

/** Plain text of any block, lines kept. */
export function blockText(n: PMNode): string {
  if (n.type === "text") return n.text ?? "";
  if (n.type === "hardBreak") return "\n";
  const parts = (n.content ?? []).map(blockText);
  const blockish = ["doc", "callout", "bulletList", "orderedList", "taskList", "listItem", "taskItem", "blockquote"].includes(n.type);
  return parts.join(blockish ? "\n" : "");
}

/** True for a callout that holds speaker notes ("Notes", "Notes:", "Speaker notes: ..."). */
export function isNotesCallout(n: PMNode): boolean {
  if (n.type !== "callout") return false;
  const first = n.content?.[0];
  const text = first ? blockText(first) : "";
  return /^\s*(speaker\s+)?notes?\b/i.test(text);
}

export function notesText(n: PMNode): string {
  return blockText(n).replace(NOTES, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function splitSlides(doc: PMNode | null | undefined, title: string): Slide[] {
  const blocks = doc?.content ?? [];
  const firstSplit = blocks.findIndex((b) => b.type === "heading" && Number(b.attrs?.level ?? 1) <= 2);
  const intro = firstSplit < 0 ? blocks : blocks.slice(0, firstSplit);
  const slides: Slide[] = [];
  const titleSlide: Slide = { kind: "title", title: title.trim() || "Untitled", blocks: [], notes: "" };
  let rest = intro.filter((b) => !(b.type === "paragraph" && !inlineText(b.content).trim()));
  const notesIntro = rest.filter(isNotesCallout);
  rest = rest.filter((b) => !isNotesCallout(b));
  titleSlide.notes = notesIntro.map(notesText).filter(Boolean).join("\n\n");
  if (rest[0]?.type === "paragraph" && inlineText(rest[0].content).length <= 200) {
    titleSlide.subtitle = inlineText(rest[0].content).trim();
    rest = rest.slice(1);
  }
  slides.push(titleSlide);
  if (rest.length) slides.push({ kind: "content", title: "", heading: null, blocks: rest, notes: "" });
  if (firstSplit < 0) return slides;

  let cur: Slide | null = null;
  for (const b of blocks.slice(firstSplit)) {
    if (b.type === "heading" && Number(b.attrs?.level ?? 1) <= 2) {
      cur = { kind: "content", title: inlineText(b.content).trim(), heading: b, blocks: [], notes: "" };
      slides.push(cur);
      continue;
    }
    if (!cur) continue;
    if (isNotesCallout(b)) { const t = notesText(b); cur.notes = cur.notes ? `${cur.notes}\n\n${t}` : t; continue; }
    cur.blocks.push(b);
  }
  // Drop trailing empty paragraphs inside slides (the editor's closing paragraph).
  for (const s of slides) while (s.blocks.length && s.blocks[s.blocks.length - 1].type === "paragraph" && !inlineText(s.blocks[s.blocks.length - 1].content).trim()) s.blocks.pop();
  return slides;
}

/** Next slide index for a key, or null when the key is not a slide key. */
export function slideKey(key: string, index: number, count: number, shift = false): number | null {
  const last = Math.max(0, count - 1);
  switch (key) {
    case "ArrowRight": case "ArrowDown": case "PageDown": case "Enter": case "n": case "N": return Math.min(last, index + 1);
    case " ": case "Spacebar": return shift ? Math.max(0, index - 1) : Math.min(last, index + 1);
    case "ArrowLeft": case "ArrowUp": case "PageUp": case "Backspace": case "p": case "P": return Math.max(0, index - 1);
    case "Home": return 0;
    case "End": return last;
    default: return null;
  }
}

/** "mm:ss" (or "h:mm:ss") for the presenter timer. */
export function clock(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}
