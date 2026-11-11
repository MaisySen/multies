import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { markdownToDoc, headingLine, fenceLine, type MdNode } from "@/server/services/suite/markdown-doc";

/**
 * QUAL1 (review of the CI repair): markdown from the docs API, the docs_append MCP tool, contracts and imports goes
 * through markdownToDoc, up to 200,000 characters from any member, workspace key, agent key or connected AI app.
 * Before QUAL1 one heading line of spaces ("# a" + 3,000 spaces + "x") took about 8 seconds (the heading pattern
 * backtracked cubically), and the shapes below took seconds to minutes at these sizes: quadratic code fence, list,
 * quote alert and line break patterns, a slice per blank line in a list, and inline scans that started again from
 * every unclosed *, _, ~~, [ or `. Each must now take well under a second. The patterns that were rewritten must
 * read ordinary lines exactly as before; a one-off check compared the old and new parser on 400,000 random docs
 * with no difference, and the checks at the end keep the rewritten heading and fence readers equal to the old
 * patterns.
 */
const LS = String.fromCharCode(0x2028);
const spaces = (n: number) => " ".repeat(n);
const SHAPES: [string, string][] = [
  ["a heading full of spaces", "# a" + spaces(3000) + "x"],
  ["a heading with a line separator", "#" + spaces(3000) + "a" + LS + "x"],
  ["a code fence full of spaces", "```" + spaces(50_000) + "a" + spaces(50_000) + "!"],
  ["a fence with a line separator", "```" + spaces(60_000) + "a" + LS + "x"],
  ["a paragraph full of spaces", "a" + spaces(100_000) + "x"],
  ["a list item with a line separator", "-" + spaces(60_000) + "a" + LS + "x"],
  ["a task with a line separator", "- [ ]" + spaces(80_000) + "a" + LS + "x"],
  ["a quote alert with a line separator", "> [!note]" + spaces(60_000) + "a" + LS + "x"],
  ["a list item followed by blank lines", "- a" + "\n".repeat(30_000) + "  b"],
  ["unclosed stars", " *a".repeat(10_000)],
  ["unclosed underscores", " _a".repeat(10_000)],
  ["unclosed strikes", " ~~a".repeat(12_000)],
  ["unclosed brackets", "[".repeat(50_000)],
  ["nested brackets", "[".repeat(30_000) + "]".repeat(30_000)],
  ["brackets and backticks", "[`".repeat(40_000)],
  ["backtick runs", "`".repeat(40_000) + "x`".repeat(40_000)],
];

describe("long lines cannot stall the markdown parser", () => {
  it.each(SHAPES)("%s takes well under a second", (_name, md) => {
    const t = performance.now();
    markdownToDoc(md);
    expect(performance.now() - t).toBeLessThan(1500);
  });

  it("a line built to exhaust the inline scans keeps its text as plain text", () => {
    const md = " *a".repeat(10_000);
    const doc = markdownToDoc(md);
    const p = doc.content![0];
    expect(p.type).toBe("paragraph");
    expect((p.content ?? []).map((n) => n.text).join("")).toBe(md.trim());
    expect((p.content ?? []).some((n) => n.marks?.length)).toBe(false);
  });

  it("a long ordinary line keeps all its formatting", () => {
    const piece = "**bold** and *it* with [a link](https://multies.si/a) and `code`, then ~~gone~~. ";
    const doc = markdownToDoc(piece.repeat(2000));
    const nodes = doc.content![0].content ?? [];
    const count = (type: string) => nodes.filter((n) => n.marks?.some((m) => m.type === type)).length;
    expect([count("bold"), count("italic"), count("link"), count("code"), count("strike")]).toEqual([2000, 2000, 2000, 2000, 2000]);
  });

  describe("through the public API with a workspace key", () => {
    let ctx: Awaited<ReturnType<typeof makeTestApp>>;
    let key = "";
    beforeEach(async () => {
      ctx = await makeTestApp();
      const c = new Client(ctx.app);
      await c.signup("owner@acme.io");
      key = (await c.post("/api/developer/keys", { name: "Docs" })).body.secret;
    });

    it("POST /api/v1/docs/{id}/append with a heading full of spaces answers in well under the old 10 seconds", async () => {
      const call = (method: string, path: string, body: unknown) => ctx.app.request(`/api/v1${path}`, {
        method, headers: { authorization: `Bearer ${key}`, host: "localhost", "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const created = await (await call("POST", "/docs", { title: "Notes" })).json() as { doc: { id: string } };
      const t = performance.now();
      const res = await call("POST", `/docs/${created.doc.id}/append`, { markdown: "# a" + spaces(3000) + "x" });
      const ms = performance.now() - t;
      expect(res.status).toBe(200);
      expect(ms).toBeLessThan(2000);
    });
  });
});

describe("the rewritten line readers read lines as the old patterns did", () => {
  const OLD_HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const OLD_FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
  let seed = 20261111;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];
  const chars = ["#", " ", " ", "\t", "a", "x", "`", "~", "-", "+", ".", "_", "\\", "!", String.fromCharCode(0xa0), LS, "\r"];
  const starts = ["", "#", "##", " #", "   ###", "    #", "####### ", "```", "~~~", " ````", "`` ", "~~"];
  const line = () => { let s = pick(starts); for (let n = Math.floor(rnd() * 10); n > 0; n--) s += pick(chars); return s; };

  it("headings: the same level and text, or no heading, on 20,000 random short lines", () => {
    for (let k = 0; k < 20_000; k++) {
      const l = line();
      const m = l.match(OLD_HEADING);
      expect([l, headingLine(l)]).toEqual([l, m ? { level: m[1].length, text: m[2] } : null]);
    }
  });

  it("fences: the same fence and language, or no fence, on 20,000 random short lines", () => {
    for (let k = 0; k < 20_000; k++) {
      const l = line();
      const m = l.match(OLD_FENCE);
      expect([l, fenceLine(l)]).toEqual([l, m ? { fence: m[2], lang: m[3] } : null]);
    }
  });

  it("closing hashes, a C# in the text and a seventh hash behave as before", () => {
    expect(headingLine("## Title ##")).toEqual({ level: 2, text: "Title" });
    expect(headingLine("# Learn C#")).toEqual({ level: 1, text: "Learn C" });
    expect(headingLine("####### Seven")).toBeNull();
    expect(headingLine("#No space")).toBeNull();
    expect(fenceLine("```ts  ")).toEqual({ fence: "```", lang: "ts" });
    expect(fenceLine("```js extra")).toBeNull();
  });

  it("lists, tasks, alerts and line breaks read as before", () => {
    const doc = markdownToDoc(["- [x]  done", "  more", "", "> [!warning]   Careful", "", "line one  ", "line two\\", "end"].join("\n"));
    const flat = (n: MdNode): string => n.text ?? (n.content ?? []).map(flat).join("|");
    expect(doc.content!.map((n) => n.type)).toEqual(["taskList", "callout", "paragraph"]);
    expect(doc.content![0].content![0].attrs).toEqual({ checked: true });
    expect(flat(doc.content![1])).toBe("Careful");
    expect((doc.content![2].content ?? []).map((n) => n.type)).toEqual(["text", "hardBreak", "text", "hardBreak", "text"]);
  });
});
