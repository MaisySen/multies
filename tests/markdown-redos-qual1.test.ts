import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { markdownToDoc, headingLine, fenceLine, linkTarget, type MdNode } from "@/server/services/suite/markdown-doc";

/**
 * QUAL1 (review of the CI repair): markdown from the docs API, the docs_append MCP tool, contracts and imports goes
 * through markdownToDoc, up to 200,000 characters from any member, workspace key, agent key or connected AI app.
 * Before QUAL1 one heading line of spaces ("# a" + 3,000 spaces + "x") took about 8 seconds (the heading pattern
 * backtracked cubically), and the shapes below took seconds to minutes at these sizes: quadratic code fence, list,
 * quote alert and line break patterns, a slice per blank line in a list, and inline scans that started again from
 * every unclosed *, _, ~~, [ or `. Each must now take well under a second. The patterns that were rewritten must
 * read ordinary lines exactly as before; a one-off check compared the old and new parser on 400,000 random docs
 * with no difference, and the checks at the end keep the rewritten heading, fence and link target readers equal to
 * the old patterns.
 *
 * Review 2 (12 Nov 2026): the link target pattern after "](" still backtracked quadratically on a run of spaces with
 * no ")" ("[a](" + 199,990 spaces + "x" took 72 seconds, 80,000 spaces 11 to 13 seconds through the API and MCP).
 * It is now a plain scan. And the work budget turned ordinary lines to plain text: about 17 unclosed openers such as
 * "_id" or "*.ts" used it up, because each one scanned to the end of the line. Each scan is now remembered per line.
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
  ["a link target of spaces with no closing bracket", "[a](" + spaces(80_000) + "x"],
  ["a link target of spaces then an unclosed title", "[a](" + spaces(40_000) + '"' + "b".repeat(40_000)],
  ["a heading with a link target of spaces", "# [a](" + spaces(80_000) + "x"],
  ["many link targets of spaces", ("[a](" + spaces(50) + "x").repeat(3000)],
  ["many unclosed openers of every kind", "_id *.ts ~~a **b [c ".repeat(10_000)],
];

describe("long lines cannot stall the markdown parser", () => {
  it.each(SHAPES)("%s takes well under a second", (_name, md) => {
    const t = performance.now();
    markdownToDoc(md);
    expect(performance.now() - t).toBeLessThan(1500);
  });

  it("a line built to exhaust the inline scans keeps its text as plain text, with its web links", () => {
    // Formatted in full, the runs of backticks would close on the single ones and make code spans.
    const md = "`".repeat(5000) + "x`".repeat(5000) + " see https://multies.si/a";
    const doc = markdownToDoc(md);
    const p = doc.content![0];
    expect(p.type).toBe("paragraph");
    expect((p.content ?? []).map((n) => n.text).join("")).toBe(md);
    expect((p.content ?? []).flatMap((n) => n.marks ?? [])).toEqual([{ type: "link", attrs: { href: "https://multies.si/a" } }]);
  });

  it("a long ordinary line keeps all its formatting", () => {
    const piece = "**bold** and *it* with [a link](https://multies.si/a) and `code`, then ~~gone~~. ";
    const doc = markdownToDoc(piece.repeat(2000));
    const nodes = doc.content![0].content ?? [];
    const count = (type: string) => nodes.filter((n) => n.marks?.some((m) => m.type === type)).length;
    expect([count("bold"), count("italic"), count("link"), count("code"), count("strike")]).toEqual([2000, 2000, 2000, 2000, 2000]);
  });

  describe("through the public API with a workspace key and MCP with an agent key", () => {
    let ctx: Awaited<ReturnType<typeof makeTestApp>>;
    let key = "";
    let agentKey = "";
    beforeEach(async () => {
      ctx = await makeTestApp();
      const c = new Client(ctx.app);
      await c.signup("owner@acme.io");
      key = (await c.post("/api/developer/keys", { name: "Docs" })).body.secret;
      // An agent needs a verified domain (as in tests/auth-hook-settings-r27.test.ts).
      const d = (await c.post("/api/domains", { name: "acme.io" })).body.domain;
      for (const r of (await c.get(`/api/domains/${d.id}`)).body.domain.records) {
        if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
        else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
      }
      await c.post(`/api/domains/${d.id}/verify`);
      const made = await c.post("/api/agents", { name: "Bot", localPart: "bot" });
      expect(made.status).toBe(201);
      agentKey = made.body.apiKey.secret;
    });
    const call = (k: string, method: string, path: string, body: unknown) => ctx.app.request(`/api/v1${path}`, {
      method, headers: { authorization: `Bearer ${k}`, host: "localhost", "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const newDoc = async () => ((await (await call(key, "POST", "/docs", { title: "Notes" })).json()) as { doc: { id: string } }).doc.id;
    const mcpAs = async (k: string) => {
      const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
      const mcp = new McpClient({ name: "test", version: "1.0.0" });
      await mcp.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${k}` } }, fetch: fetchViaApp }));
      return mcp;
    };
    const LINK_SPACES = "[a](" + spaces(80_000) + "x";

    it("POST /api/v1/docs/{id}/append with a heading full of spaces answers in well under the old 10 seconds", async () => {
      const id = await newDoc();
      const t = performance.now();
      const res = await call(key, "POST", `/docs/${id}/append`, { markdown: "# a" + spaces(3000) + "x" });
      const ms = performance.now() - t;
      expect(res.status).toBe(200);
      expect(ms).toBeLessThan(2000);
    });

    it("POST /api/v1/docs/{id}/append with a link target of spaces answers in well under the old 12 seconds", async () => {
      const id = await newDoc();
      const t = performance.now();
      const res = await call(key, "POST", `/docs/${id}/append`, { markdown: LINK_SPACES });
      const ms = performance.now() - t;
      expect(res.status).toBe(200);
      expect(ms).toBeLessThan(2000);
    });

    it("MCP docs_append with an agent key and a link target of spaces", async () => {
      const id = await newDoc();
      const mcp = await mcpAs(agentKey);
      const t = performance.now();
      const r = await mcp.callTool({ name: "docs_append", arguments: { id, markdown: LINK_SPACES } });
      const ms = performance.now() - t;
      expect((r as { isError?: boolean }).isError ?? false).toBe(false);
      expect(ms).toBeLessThan(2000);
      await mcp.close();
    });

    it("MCP docs_add_block with an agent key and callout text that holds a link target of spaces", async () => {
      const id = await newDoc();
      const mcp = await mcpAs(agentKey);
      const t = performance.now();
      const r = await mcp.callTool({ name: "docs_add_block", arguments: { id, type: "callout", variant: "info", text: "[a](" + spaces(49_990) + "x" } });
      const ms = performance.now() - t;
      expect((r as { isError?: boolean }).isError ?? false).toBe(false);
      expect(ms).toBeLessThan(2000);
      await mcp.close();
    });
  });
});

describe("ordinary lines keep their formatting under the work budget", () => {
  const names = ["id", "rev", "key", "from", "to", "deleted", "attachments", "conflicts", "revisions", "local_seq", "meta", "owner", "created", "updated", "parent", "index"];
  const fields = (k: number) => "Reserved fields: " + Array.from({ length: k }, (_, n) => "_" + names[n % names.length] + (n >= names.length ? n : "")).join(", ")
    + ". **Note:** do not set them; see [the guide](https://example.com/guide) and `read_doc`.";
  const markTypes = (doc: MdNode) => (doc.content![0].content ?? []).flatMap((n) => (n.marks ?? []).map((m) => m.type));

  it("20 underscore field names: bold, link and code kept", () => {
    expect(markTypes(markdownToDoc(fields(20)))).toEqual(["bold", "link", "code"]);
  });

  it("30 underscore field names (a 395 character line): bold, link and code kept", () => {
    const line = fields(30);
    expect(line.length).toBe(395);
    expect(markTypes(markdownToDoc(line))).toEqual(["bold", "link", "code"]);
  });

  it("2,000 underscore field names on one line: bold, link and code kept", () => {
    expect(markTypes(markdownToDoc(fields(2000)))).toEqual(["bold", "link", "code"]);
  });

  it("a long pasted paragraph with 18 underscore names near its start keeps bold, link and code", () => {
    const prose = "Notes on _id _rev _key _from _to _deleted _attachments _conflicts _revisions _local _meta _owner _created _updated _parent _index _a1 _a2 fields. **Keep** this [link](https://example.com/x) and `code`. " + "Plain words follow here. ".repeat(400);
    expect(prose.length).toBe(10_202);
    expect(markTypes(markdownToDoc(prose))).toEqual(["bold", "link", "code"]);
  });

  it("a line of 45 file globs keeps italic, link and code", () => {
    const globs = Array.from({ length: 45 }, (_, n) => "*.e" + n).join(" ");
    const line = "Match " + globs + " but *not* these; see [the list](https://example.com/globs) and `glob()`.";
    expect(markTypes(markdownToDoc(line))).toEqual(["italic", "link", "code"]);
  });

  it("a line of 40 half open ranges keeps bold, link and code", () => {
    const line = Array.from({ length: 40 }, (_, n) => `x in [${n}, ${n + 1})`).join(", ") + ". **Note** [the guide](https://example.com/r) `range()`.";
    expect(markTypes(markdownToDoc(line))).toEqual(["bold", "link", "code"]);
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

  it("link targets: the same address and end, or no link, on 50,000 random short targets", () => {
    const OLD_LINK = /^\s*<?([^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*)>?(?:\s+["'][^"']*["'])?\s*\)/;
    const parts = [" ", " ", "\t", String.fromCharCode(0xa0), LS, "(", ")", "(", ")", "<", ">", '"', "'", "\\", "[", "]", "a", "x", "/"];
    let matched = 0;
    for (let k = 0; k < 50_000; k++) {
      let r = "";
      for (let n = Math.floor(rnd() * 14); n > 0; n--) r += pick(parts);
      const before = k % 3 === 0 ? "[a](" : "";
      const m = r.match(OLD_LINK);
      if (m) matched++;
      expect([r, linkTarget(before + r, before.length)]).toEqual([r, m ? { href: m[1], end: before.length + m[0].length } : null]);
    }
    expect(matched).toBeGreaterThan(5000);
  });

  it("emphasis, code and links read as the parser before QUAL1 did", () => {
    const flat = (md: string) => (markdownToDoc(md).content![0].content ?? []).map((n) => [n.text, (n.marks ?? []).map((m) => m.type + (m.attrs ? "=" + String(m.attrs.href) : "")).join("+")]);
    expect(flat("_a _b_ c")).toEqual([["a _b", "italic"], [" c", ""]]);
    expect(flat("*a `*` b*")).toEqual([["a ", "italic"], ["*", "code"], [" b", "italic"]]);
    expect(flat("*a **b** c*")).toEqual([["a *", "italic"], ["b** c*", ""]]);
    expect(flat("a *b `c* d` e*")).toEqual([["a ", ""], ["b ", "italic"], ["c* d", "code"], [" e", "italic"]]);
    expect(flat("_one _two _three **bold** _four_")).toEqual([["one _two _three ", "italic"], ["bold", "italic+bold"], [" _four", "italic"]]);
    expect(flat("*.ts *.md *x* and **y**")).toEqual([[".ts *.md *x", "italic"], [" and ", ""], ["y", "bold"]]);
    expect(flat("[a [b](c)](d)")).toEqual([["a [b](c)", "link=d"]]);
    expect(flat("[a]( \"t\") [b](<c> 'd') [e](f(g)h) [i](j \"k')")).toEqual([["a", "link=\"t\""], [" ", ""], ["b", "link=c"], [" ", ""], ["e", "link=f(g)h"], [" ", ""], ["i", "link=j"]]);
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
