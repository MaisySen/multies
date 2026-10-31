/**
 * R84: the pure text helpers behind the task description editor and @mentions (no React, so tests run them in node).
 */
interface Person { type: string; id: string; name: string; email?: string | null }

/** The word people type after @ to mention someone: their first name, or the name before @ in their email when first names clash. */
export function mentionHandle(p: Person, all: Person[]) {
  const first = p.name.trim().split(/\s+/)[0] ?? p.name;
  const clash = all.filter((x) => x.type === "member" && (x.name.trim().split(/\s+/)[0] ?? "").toLowerCase() === first.toLowerCase()).length > 1;
  return clash && p.email ? p.email.split("@")[0]! : first;
}

/** The @word being typed right before the caret, if any. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|[\s(])@([\w.-]{0,30})$/.exec(before);
  return m ? { start: caret - m[2]!.length - 1, query: m[2]! } : null;
}

/** Turns the small markdown set the toolbar writes into safe HTML (everything is escaped first). */
export function renderNotes(md: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const inline = (s: string) => esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t: string, u: string) => `<a href="${u}" target="_blank" rel="noreferrer noopener">${t}</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (_m, a: string, u: string) => `${a}<a href="${u}" target="_blank" rel="noreferrer noopener">${u}</a>`)
    .replace(/(^|[\s(])@([\w.-]+)/g, '$1<span class="mention">@$2</span>');
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    let m: RegExpExecArray | null;
    if ((m = /^- \[( |x)\] (.*)$/i.exec(line))) { if (list !== "ul") { close(); out.push('<ul class="checks">'); list = "ul"; } out.push(`<li><input type="checkbox" disabled aria-label="${m[1] !== " " ? "Done" : "Not done"}"${m[1] !== " " ? " checked" : ""}> ${inline(m[2]!)}</li>`); }
    else if ((m = /^[-*] (.*)$/.exec(line))) { if (list !== "ul") { close(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1]!)}</li>`); }
    else if ((m = /^\d+[.)] (.*)$/.exec(line))) { if (list !== "ol") { close(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(m[1]!)}</li>`); }
    else if ((m = /^#{1,3} (.*)$/.exec(line))) { close(); out.push(`<h4>${inline(m[1]!)}</h4>`); }
    else if (!line) { close(); out.push(""); }
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  return out.join("\n");
}

export type Fmt = "bold" | "italic" | "heading" | "bullets" | "numbers" | "checks" | "link" | "code";
/** Applies one toolbar format to the selection; returns the new text and selection. */
export function applyFormat(text: string, start: number, end: number, fmt: Fmt): { text: string; start: number; end: number } {
  const sel = text.slice(start, end);
  const wrap = (a: string, b = a, empty = "text") => {
    const body = sel || empty;
    return { text: text.slice(0, start) + a + body + b + text.slice(end), start: start + a.length, end: start + a.length + body.length };
  };
  if (fmt === "bold") return wrap("**");
  if (fmt === "italic") return wrap("*");
  if (fmt === "code") return wrap("`", "`", "code");
  if (fmt === "link") return wrap("[", "](https://)", "link");
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = (() => { const i = text.indexOf("\n", end); return i < 0 ? text.length : i; })();
  const lines = text.slice(lineStart, lineEnd).split("\n");
  const prefix = (i: number) => (fmt === "heading" ? "## " : fmt === "bullets" ? "- " : fmt === "numbers" ? `${i + 1}. ` : "- [ ] ");
  const strip = (l: string) => l.replace(/^(#{1,3} |- \[[ x]\] |[-*] |\d+[.)] )/i, "");
  const already = lines.every((l, i) => l.startsWith(prefix(i).replace(/\d+/, String(i + 1))));
  const next = lines.map((l, i) => (already ? strip(l) : prefix(i) + strip(l))).join("\n");
  return { text: text.slice(0, lineStart) + next + text.slice(lineEnd), start: lineStart, end: lineStart + next.length };
}

