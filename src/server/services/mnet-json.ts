// Dedicated to the bounded Mnet bridge request reader. Native and browser
// approval fields must be unambiguous before a strict schema sees their values.
// JSON.parse alone loses duplicate keys, including escaped spelling aliases.
export function parseMnetObject(text: string): unknown {
  let at = 0;
  const bad = (): never => { throw new Error("Invalid Mnet JSON"); };
  const space = () => { while (at < text.length && /[\x20\t\r\n]/.test(text[at])) at++; };
  const string = (): string => {
    if (text[at] !== '"') return bad();
    const start = at++;
    while (at < text.length) {
      const ch = text[at++];
      if (ch === '"') return JSON.parse(text.slice(start, at)) as string;
      if (ch === "\\") {
        if (at >= text.length) return bad();
        at++;
      }
    }
    return bad();
  };
  const value = (depth: number): void => {
    if (depth > 16) return bad();
    space();
    const ch = text[at];
    if (ch === '"') { string(); return; }
    if (ch === "{" || ch === "[") {
      at++;
      const object = ch === "{";
      const close = object ? "}" : "]";
      const seen = new Set<string>();
      space();
      if (text[at] === close) { at++; return; }
      for (;;) {
        space();
        if (object) {
          const key = string();
          if (seen.has(key)) return bad();
          seen.add(key);
          space();
          if (text[at++] !== ":") return bad();
        }
        value(depth + 1);
        space();
        if (text[at] === close) { at++; return; }
        if (text[at++] !== ",") return bad();
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at));
    if (!token) return bad();
    at += token[0].length;
  };
  space();
  if (text[at] !== "{") return bad();
  value(0);
  space();
  if (at !== text.length) return bad();
  // The scanner checks scope/depth and duplicate decoded keys; the platform
  // parser remains the final authority on JSON grammar and escape validity.
  return JSON.parse(text) as unknown;
}
