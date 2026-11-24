/**
 * M1: Docs on the phone, read only. The web stores a doc as the editor's own JSON (Tiptap, ProseMirror: StarterKit,
 * task lists, R32 tables, images and callouts, R89 whiteboards and diagrams; see the web's doc-editor-shape.ts and the
 * share page's renderDocHtml). The phone turns that JSON into simple blocks it can draw natively. Comments (R103 Docs
 * plus) and read only share links (R26) use the web's own routes and rules; the server checks every one.
 */

export interface PMMark { type: string; attrs?: Record<string, unknown> }
export interface PMNode { type?: string; text?: string; content?: PMNode[]; attrs?: Record<string, unknown>; marks?: PMMark[] }

// ---------------------------------------------------------------- tree

export interface TreeNode { id: string; title: string; parentId: string | null; position: number; projectId: string | null; updatedAt: string; depth: number; children: TreeNode[]; kind?: "whiteboard" }
export interface DocTree { tree: TreeNode[]; count: number; truncated: boolean; maxDepth: number }
export interface TreeRow { id: string; title: string; depth: number; hasChildren: boolean; kind: "doc" | "whiteboard"; updatedAt: string; path: string[] }

export const untitled = (t: string | null | undefined) => (t && t.trim() ? t.trim() : "Untitled");

/**
 * The tree as rows in reading order. Folded pages hide their children. With a search, every page whose title matches is
 * shown with the pages above it, so the person sees where it sits.
 */
export function treeRows(tree: TreeNode[], opts: { open?: Set<string>; query?: string } = {}): TreeRow[] {
  const q = (opts.query ?? "").trim().toLowerCase();
  const out: TreeRow[] = [];
  const keep = new Set<string>();
  if (q) {
    const mark = (n: TreeNode, up: string[]): boolean => {
      let hit = untitled(n.title).toLowerCase().includes(q);
      for (const c of n.children ?? []) if (mark(c, [...up, n.id])) hit = true;
      if (hit) keep.add(n.id);
      return hit;
    };
    for (const n of tree) mark(n, []);
  }
  const walk = (nodes: TreeNode[], depth: number, path: string[], guard: number) => {
    if (guard > 64) return;
    for (const n of [...nodes].sort((a, b) => a.position - b.position)) {
      if (q && !keep.has(n.id)) continue;
      const kids = n.children ?? [];
      out.push({ id: n.id, title: untitled(n.title), depth, hasChildren: kids.length > 0, kind: n.kind === "whiteboard" ? "whiteboard" : "doc", updatedAt: n.updatedAt, path });
      if (kids.length && (q || opts.open?.has(n.id))) walk(kids, depth + 1, [...path, untitled(n.title)], guard + 1);
    }
  };
  walk(tree ?? [], 0, [], 0);
  return out;
}

// ---------------------------------------------------------------- the doc

export interface DocView {
  id: string; title: string; kind: string; projectId: string | null; parentId: string | null; excerpt?: string;
  content: PMNode; text: string; createdBy: { type: string; id: string }; createdAt: string; updatedAt: string; version: number;
}

/** A run of text with its marks, ready for a Text. */
export interface Span { text: string; bold?: boolean; italic?: boolean; strike?: boolean; underline?: boolean; code?: boolean; href?: string; mention?: boolean }

export type Block =
  | { t: "heading"; level: 1 | 2 | 3 | 4; spans: Span[] }
  | { t: "paragraph"; spans: Span[] }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "tasks"; items: { checked: boolean; blocks: Block[] }[] }
  | { t: "quote"; blocks: Block[] }
  | { t: "code"; text: string; language: string | null }
  | { t: "rule" }
  | { t: "image"; src: string; alt: string; width: number | null; height: number | null }
  | { t: "table"; rows: { header: boolean; cells: Span[][] }[] }
  | { t: "callout"; variant: "info" | "success" | "warning" | "danger"; blocks: Block[] }
  | { t: "web"; what: string; words: string[] };

const MAX_DEPTH = 40;

/** Text runs of an inline node list (text, hard breaks, mentions). */
export function spansOf(nodes: PMNode[] | undefined, depth = 0): Span[] {
  const out: Span[] = [];
  for (const n of nodes ?? []) {
    if (!n || typeof n !== "object" || depth > MAX_DEPTH) continue;
    if (n.type === "text") {
      const s: Span = { text: typeof n.text === "string" ? n.text : "" };
      for (const m of n.marks ?? []) {
        if (m.type === "bold") s.bold = true;
        else if (m.type === "italic") s.italic = true;
        else if (m.type === "strike") s.strike = true;
        else if (m.type === "underline") s.underline = true;
        else if (m.type === "code") s.code = true;
        else if (m.type === "link" && typeof m.attrs?.href === "string" && safeHref(m.attrs.href)) s.href = m.attrs.href;
      }
      if (s.text) out.push(s);
    } else if (n.type === "hardBreak") out.push({ text: "\n" });
    else if (n.type === "mention") {
      const label = n.attrs?.label ?? n.attrs?.name;
      if (typeof label === "string" && label) out.push({ text: `@${label}`, mention: true });
    } else if (Array.isArray(n.content)) out.push(...spansOf(n.content, depth + 1));
  }
  return out;
}

/** Links the phone will follow: web pages, mail and phone links, and the app's own pages. */
export function safeHref(h: string): boolean {
  return /^(https?:|mailto:|tel:)/i.test(h) || h.startsWith("/");
}

/** All the text inside a node (for code blocks and diagrams). */
export function plainOf(n: PMNode | undefined, depth = 0): string {
  if (!n || depth > MAX_DEPTH) return "";
  if (n.type === "text") return n.text ?? "";
  if (n.type === "hardBreak") return "\n";
  return (n.content ?? []).map((c) => plainOf(c, depth + 1)).join(n.type === "doc" ? "\n" : "");
}

/** The words written on a whiteboard (the drawing itself needs the web). */
export function whiteboardWords(scene: unknown): string[] {
  try {
    const els = JSON.parse(typeof scene === "string" ? scene : "[]") as { type?: string; text?: string; isDeleted?: boolean }[];
    if (!Array.isArray(els)) return [];
    return els.filter((e) => e && e.type === "text" && !e.isDeleted && typeof e.text === "string" && e.text.trim()).map((e) => String(e.text).slice(0, 300)).slice(0, 50);
  } catch { return []; }
}

const INLINE = new Set(["text", "hardBreak", "mention"]);

/** The doc's blocks, in order. Unknown blocks with text show their text; ones without show an "Open on the web" card. */
export function blocksOf(nodes: PMNode[] | undefined, depth = 0): Block[] {
  const out: Block[] = [];
  for (const n of nodes ?? []) {
    if (!n || typeof n !== "object" || depth > MAX_DEPTH) continue;
    const kids = Array.isArray(n.content) ? n.content : [];
    switch (n.type) {
      case "paragraph": { const spans = spansOf(kids); out.push({ t: "paragraph", spans }); break; }
      case "heading": { const l = Math.min(Math.max(Number(n.attrs?.level) || 2, 1), 4) as 1 | 2 | 3 | 4; out.push({ t: "heading", level: l, spans: spansOf(kids) }); break; }
      case "bulletList": case "orderedList": {
        const s = Number(n.attrs?.start);
        out.push({ t: "list", ordered: n.type === "orderedList", start: Number.isInteger(s) && s > 0 ? s : 1, items: kids.map((li) => blocksOf(li.content, depth + 1)) });
        break;
      }
      case "taskList": out.push({ t: "tasks", items: kids.map((ti) => ({ checked: !!ti.attrs?.checked, blocks: blocksOf(ti.content, depth + 1) })) }); break;
      case "listItem": case "taskItem": out.push(...blocksOf(kids, depth + 1)); break;
      case "blockquote": out.push({ t: "quote", blocks: blocksOf(kids, depth + 1) }); break;
      case "codeBlock": out.push({ t: "code", text: plainOf(n), language: typeof n.attrs?.language === "string" ? n.attrs.language : null }); break;
      case "horizontalRule": out.push({ t: "rule" }); break;
      case "image": {
        const src = typeof n.attrs?.src === "string" ? n.attrs.src : "";
        const alt = typeof n.attrs?.alt === "string" ? n.attrs.alt : "";
        const num = (v: unknown) => (typeof v === "number" && v > 0 ? v : typeof v === "string" && Number(v) > 0 ? Number(v) : null);
        if (imageSrcOk(src)) out.push({ t: "image", src, alt, width: num(n.attrs?.width), height: num(n.attrs?.height) });
        else if (alt) out.push({ t: "paragraph", spans: [{ text: alt, italic: true }] });
        break;
      }
      case "table": {
        const rows = kids.filter((r) => r.type === "tableRow").map((r) => {
          const cells = (r.content ?? []).filter((c) => c.type === "tableCell" || c.type === "tableHeader");
          return { header: cells.length > 0 && cells.every((c) => c.type === "tableHeader"), cells: cells.map((c) => spansOf(flatInline(c.content))) };
        });
        if (rows.length) out.push({ t: "table", rows });
        break;
      }
      case "callout": {
        const v = String(n.attrs?.variant);
        out.push({ t: "callout", variant: v === "success" || v === "warning" || v === "danger" ? v : "info", blocks: blocksOf(kids, depth + 1) });
        break;
      }
      case "whiteboard": out.push({ t: "web", what: "Whiteboard", words: whiteboardWords(n.attrs?.scene) }); break;
      case "diagram": out.push({ t: "web", what: "Diagram", words: [] }); break;
      default: {
        if (n.type && INLINE.has(n.type)) { out.push({ t: "paragraph", spans: spansOf([n]) }); break; }
        if (kids.length) out.push(...blocksOf(kids, depth + 1));
        else if (n.type && n.type !== "doc") out.push({ t: "web", what: "This part", words: [] });
      }
    }
  }
  return out;
}

/** Table cells hold paragraphs: their text joined with line breaks, so a cell reads as one run. */
function flatInline(nodes: PMNode[] | undefined): PMNode[] {
  const out: PMNode[] = [];
  (nodes ?? []).forEach((n, i) => {
    if (i > 0) out.push({ type: "hardBreak" });
    if (n.type === "paragraph" || n.type === "heading") out.push(...(n.content ?? []));
    else out.push({ type: "text", text: plainOf(n) });
  });
  return out;
}

/** The trailing empty paragraph the editor always adds is dropped, as are runs of empty ones. */
export function docBlocks(content: PMNode | null | undefined): Block[] {
  const all = blocksOf(content?.type === "doc" ? content.content : content ? [content] : []);
  const out: Block[] = [];
  for (const b of all) {
    const empty = b.t === "paragraph" && !b.spans.some((s) => s.text.trim());
    const prevEmpty = out.length > 0 && out[out.length - 1].t === "paragraph" && !(out[out.length - 1] as { spans: Span[] }).spans.some((s) => s.text.trim());
    if (empty && (out.length === 0 || prevEmpty)) continue;
    out.push(b);
  }
  while (out.length && out[out.length - 1].t === "paragraph" && !(out[out.length - 1] as { spans: Span[] }).spans.some((s) => s.text.trim())) out.pop();
  return out;
}

/** Images the phone can load: https, inline data, or the workspace's own uploads (loaded with the session). */
export function imageSrcOk(src: string): boolean {
  return /^https:\/\//i.test(src) || /^data:image\/(png|jpeg|gif|webp);base64,/i.test(src) || /^\/api\//.test(src);
}

/** The full address and whether the session cookie must go with it (only to the workspace's own server). */
export function imageSource(src: string, base: string, headers: () => Record<string, string>): { uri: string; headers?: Record<string, string> } {
  if (src.startsWith("/")) return { uri: `${base}${src}`, headers: headers() };
  if (base && src.startsWith(base + "/")) return { uri: src, headers: headers() };
  return { uri: src };
}

// ---------------------------------------------------------------- comments (R103)

export type CommentThread = "team" | "public";
export type CommentStatus = "visible" | "pending" | "hidden";
export interface CommentView {
  id: string; thread: CommentThread; body: string; status: CommentStatus;
  author: { type: string; name: string; email?: string };
  createdAt: string; editedAt: string | null; mine: boolean; canEdit: boolean; canRemove: boolean;
}
export interface CommentList { team: CommentView[]; public: CommentView[]; pending: number; canModerate: boolean; publicOn: boolean }
export const COMMENT_MAX = 4000;

/** Error words for a comment body, or null when it can be sent. */
export function commentProblem(body: string): string | null {
  const b = body.trim();
  if (!b) return "Write a comment first.";
  if (b.length > COMMENT_MAX) return `Keep it under ${COMMENT_MAX.toLocaleString("en-AU")} characters.`;
  return null;
}

/** The moderation action a moderator sees on a public comment (Show or Hide), as on the web. */
export function moderation(c: CommentView, canModerate: boolean): { label: "Show" | "Hide"; status: CommentStatus } | null {
  if (!canModerate || c.thread !== "public") return null;
  return c.status === "visible" ? { label: "Hide", status: "hidden" } : { label: "Show", status: "visible" };
}

// ---------------------------------------------------------------- share links (R26)

export interface ShareLink { id: string; kind: "doc" | "project_board"; targetId: string; showWorkspaceName: boolean; createdBy: string; createdAt: string; expiresAt: string | null; comments?: string; url?: string }
export interface ShareList { links: ShareLink[]; allowShareLinks: boolean }
export type Expiry = "never" | "7" | "30";
export const EXPIRY_CHOICES: { id: Expiry; label: string }[] = [{ id: "never", label: "Always" }, { id: "7", label: "7 days" }, { id: "30", label: "30 days" }];
/** Round 2 (PR 24): a new share link works 30 days unless the person picks another choice (the web's default too). */
export const DEFAULT_EXPIRY: Expiry = "30";
export const expiryDays = (e: Expiry): 7 | 30 | null => (e === "never" ? null : e === "7" ? 7 : 30);

/** "Made 1 Nov 2026, works until 8 Nov 2026" for a link row. */
export function linkLine(l: Pick<ShareLink, "createdAt" | "expiresAt">): string {
  const d = (s: string) => new Date(s).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  return `Made ${d(l.createdAt)}, ${l.expiresAt ? `works until ${d(l.expiresAt)}` : "works until turned off"}`;
}

/** The web page for a doc, for the Open on the web button (editing stays on the web). */
export const docWebPath = (id: string) => `/app/docs/${encodeURIComponent(id)}`;

/** True for errors that mean "you can't open this" (not found, no access), so screens show a plain no access state. */
export function noAccess(e: unknown): boolean {
  const s = (e as { status?: number } | null)?.status;
  return s === 401 || s === 403 || s === 404;
}
