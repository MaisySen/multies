import { describe, expect, it } from "vitest";
import {
  FLOW_TEMPLATES, changeSummary, diffLines, evaluateCondition, fillPlaceholders, hasCycle, logJson, nextNode, redact, stepBackoff, testRule, validateGraph,
  waitUntil, watchBackoff, WAIT_MAX_MS, type FlowGraph,
} from "@/shared/flows";
import { checkWatchUrl, htmlText, parseFeed, parseSelector, robotsAllows, robotsRules, selectHtml } from "@/server/services/suite/flow-watch";
import { nextDigestTime } from "@/server/services/suite/flows";
import type { Deps } from "@/server/context";

/** R90: the automation builder's rules, without a database. */
const vars = { trigger: { title: "Fix the login page", priority: "urgent", count: "12", empty: "", tags: [] as string[] }, steps: { a1: { taskId: "tsk_1" } } };

describe("condition evaluator", () => {
  it("each test, case and space insensitive", () => {
    expect(testRule({ field: "trigger.priority", op: "equals", value: " Urgent " }, vars)).toBe(true);
    expect(testRule({ field: "trigger.priority", op: "not_equals", value: "low" }, vars)).toBe(true);
    expect(testRule({ field: "trigger.title", op: "contains", value: "LOGIN" }, vars)).toBe(true);
    expect(testRule({ field: "trigger.title", op: "not_contains", value: "logout" }, vars)).toBe(true);
    expect(testRule({ field: "trigger.title", op: "starts_with", value: "fix" }, vars)).toBe(true);
    expect(testRule({ field: "trigger.empty", op: "is_empty" }, vars)).toBe(true);
    expect(testRule({ field: "trigger.tags", op: "is_empty" }, vars)).toBe(true);
    expect(testRule({ field: "trigger.missing", op: "is_empty" }, vars)).toBe(true);
    expect(testRule({ field: "trigger.title", op: "is_not_empty" }, vars)).toBe(true);
    expect(testRule({ field: "trigger.count", op: "greater_than", value: "9" }, vars)).toBe(true);
    expect(testRule({ field: "trigger.count", op: "less_than", value: "9" }, vars)).toBe(false);
    expect(testRule({ field: "steps.a1.taskId", op: "equals", value: "tsk_1" }, vars)).toBe(true);
  });
  it("numbers compare only when both sides are numbers; an empty contains never matches", () => {
    expect(testRule({ field: "trigger.title", op: "greater_than", value: "1" }, vars)).toBe(false);
    expect(testRule({ field: "trigger.empty", op: "less_than", value: "1" }, vars)).toBe(false);
    expect(testRule({ field: "trigger.title", op: "contains", value: "" }, vars)).toBe(false);
  });
  it("does not read inherited keys", () => {
    expect(testRule({ field: "trigger.constructor", op: "is_not_empty" }, vars)).toBe(false);
    expect(testRule({ field: "trigger.__proto__", op: "is_not_empty" }, vars)).toBe(false);
  });
  it("all, any, and no rules", () => {
    const rules = [{ field: "trigger.priority", op: "equals" as const, value: "urgent" }, { field: "trigger.title", op: "contains" as const, value: "nope" }];
    expect(evaluateCondition({ match: "all", rules }, vars)).toBe(false);
    expect(evaluateCondition({ match: "any", rules }, vars)).toBe(true);
    expect(evaluateCondition({ match: "all", rules: [] }, vars)).toBe(true);
    expect(evaluateCondition(undefined, vars)).toBe(true);
  });
});

const g: FlowGraph = {
  nodes: [
    { id: "t", kind: "trigger", config: { trigger: "task_created" }, x: 0, y: 0 },
    { id: "c", kind: "condition", config: { match: "all", rules: [{ field: "trigger.priority", op: "equals", value: "urgent" }] }, x: 0, y: 0 },
    { id: "a", kind: "action", config: { action: "notify" }, x: 0, y: 0 },
    { id: "b", kind: "action", config: { action: "create_task" }, x: 0, y: 0 },
    { id: "e", kind: "action", config: { action: "notify" }, x: 0, y: 0 },
  ],
  edges: [{ id: "1", from: "t", to: "c", branch: "next" }, { id: "2", from: "c", to: "a", branch: "yes" }, { id: "3", from: "c", to: "b", branch: "no" }, { id: "4", from: "a", to: "e", branch: "error" }],
};

describe("branch routing", () => {
  it("follows next, yes, no and error edges; nothing after is the end", () => {
    expect(nextNode(g, "t", "next")).toBe("c");
    expect(nextNode(g, "c", "yes")).toBe("a");
    expect(nextNode(g, "c", "no")).toBe("b");
    expect(nextNode(g, "a", "error")).toBe("e");
    expect(nextNode(g, "a", "next")).toBeNull();
    expect(nextNode(g, "b", "next")).toBeNull();
  });
  it("a valid graph has no problems; a starter template's only problems are the blanks it asks you to fill", () => {
    expect(validateGraph(g)).toEqual([]);
    for (const t of FLOW_TEMPLATES) for (const p of validateGraph(t.graph)) expect(p.message, t.key).toMatch(/address to watch|Pick a channel|Pick a webhook/);
    const page = FLOW_TEMPLATES.find((t) => t.key === "page_alert")!.graph;
    const filled = { ...page, nodes: page.nodes.map((n) => (n.kind === "trigger" ? { ...n, config: { ...n.config, url: "https://example.com" } } : n)) };
    expect(validateGraph(filled)).toEqual([]);
  });
  it("finds loops, loose steps, wrong branches and task only actions on other triggers", () => {
    const loop = { ...g, edges: [...g.edges, { id: "5", from: "b", to: "c", branch: "next" as const }] };
    expect(hasCycle(loop)).toBe(true);
    expect(validateGraph(loop).some((p) => /loop/.test(p.message))).toBe(true);
    const loose = { ...g, nodes: [...g.nodes, { id: "z", kind: "stop" as const, config: {}, x: 0, y: 0 }] };
    expect(validateGraph(loose).find((p) => p.nodeId === "z")?.message).toMatch(/not joined/);
    const twoNext = { ...g, edges: [...g.edges, { id: "6", from: "t", to: "b", branch: "next" as const }] };
    expect(validateGraph(twoNext).some((p) => /one next step/.test(p.message))).toBe(true);
    const yesOnAction = { ...g, edges: [...g.edges, { id: "7", from: "b", to: "e", branch: "yes" as const }] };
    expect(validateGraph(yesOnAction).some((p) => /Only a condition/.test(p.message))).toBe(true);
    const formFlow: FlowGraph = { nodes: [{ id: "t", kind: "trigger", config: { trigger: "form_submitted" }, x: 0, y: 0 }, { id: "s", kind: "action", config: { action: "set_status" }, x: 0, y: 0 }], edges: [{ id: "1", from: "t", to: "s", branch: "next" }] };
    expect(validateGraph(formFlow)[0].message).toMatch(/only when a task starts/);
    expect(validateGraph({ nodes: [], edges: [] })[0].message).toMatch(/trigger/);
  });
});

describe("wait scheduling and retry backoff", () => {
  const now = Date.UTC(2026, 9, 31, 12, 0);
  it("waits the amount in its unit, at least a minute and at most 30 days", () => {
    expect(waitUntil(now, { amount: 2, unit: "hours" })).toBe(now + 7_200_000);
    expect(waitUntil(now, { amount: 3, unit: "days" })).toBe(now + 3 * 86_400_000);
    expect(waitUntil(now, { amount: 0, unit: "minutes" })).toBe(now + 60_000);
    expect(waitUntil(now, { amount: 400, unit: "days" })).toBe(now + WAIT_MAX_MS);
    expect(waitUntil(now, { amount: "5", unit: "weeks" })).toBe(now + 5 * 3_600_000);
    expect(waitUntil(now, { amount: -4, unit: "hours" })).toBe(now + 60_000);
  });
  it("two automatic retries, a minute then five, then none", () => {
    expect(stepBackoff(2)).toBe(60_000);
    expect(stepBackoff(3)).toBe(300_000);
    expect(stepBackoff(4)).toBeNull();
  });
  it("a failing watch checks less often, up to once a day", () => {
    expect(watchBackoff(60, 0)).toBe(3_600_000);
    expect(watchBackoff(60, 1)).toBe(7_200_000);
    expect(watchBackoff(360, 5)).toBe(1440 * 60_000);
  });
  it("digests go at 8 in the morning in the workspace zone, weekly on Monday", () => {
    const sun = Date.UTC(2026, 10, 1, 1, 0); // Sunday 12:00 in Sydney (AEDT, UTC+11)
    const daily = nextDigestTime(sun, "Australia/Sydney", "daily");
    expect(new Date(daily).toISOString()).toBe("2026-11-01T21:00:00.000Z");
    const weekly = nextDigestTime(sun, "Australia/Sydney", "weekly");
    expect(new Date(weekly).toISOString()).toBe("2026-11-01T21:00:00.000Z"); // Monday 8 am Sydney
    expect(new Date(nextDigestTime(Date.UTC(2026, 10, 2, 9), "UTC", "weekly")).toISOString()).toBe("2026-11-09T08:00:00.000Z");
    expect(nextDigestTime(sun, "Not/AZone", "daily")).toBeGreaterThan(sun);
  });
});

describe("placeholders and the run log", () => {
  it("fills known fields and empties unknown ones", () => {
    expect(fillPlaceholders("Task {trigger.title} ({trigger.nope})", vars)).toBe("Task Fix the login page ()");
  });
  it("hides secret looking keys at any depth and keeps the log under its cap", () => {
    const r = redact({ token: "abc", nested: { apiKey: "x", Authorization: "Bearer y", ok: 1 }, list: [{ password: "p" }] }) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(r.token).toBe("[hidden]");
    expect(r.nested.apiKey).toBe("[hidden]");
    expect(r.nested.Authorization).toBe("[hidden]");
    expect(r.nested.ok).toBe(1);
    expect(r.list[0].password).toBe("[hidden]");
    const big = logJson({ text: "x".repeat(30_000), more: Array.from({ length: 40 }, () => "y".repeat(1900)) });
    expect(big.length).toBeLessThanOrEqual(8_000);
  });
});

describe("page change detection", () => {
  it("lists added and removed lines, ignoring blank lines and spacing", () => {
    const d = diffLines("Price: $10\nIn stock\n\nShips today", "Price: $12\n  In stock\nShips today\nNew colour");
    expect(d.added).toEqual(["Price: $12", "New colour"]);
    expect(d.removed).toEqual(["Price: $10"]);
    expect(changeSummary(d)).toBe("2 lines added, 1 line removed");
    expect(changeSummary(diffLines("a\nb", "a\nb"))).toBe("No change");
  });
  it("reads page text without scripts, styles or comments", () => {
    const html = "<html><head><style>p{}</style><script>var x=1</script></head><body><!-- hi --><h1>Plans</h1><p>Pro &amp; Team&nbsp;now</p><div>Price <b>$12</b></div></body></html>";
    expect(htmlText(html)).toBe("Plans\nPro & Team now\nPrice $12");
  });
  it("picks one part of a page by a simple selector", () => {
    const html = '<div class="a"><div id="price" class="big tag">$12 <div>inner</div></div></div><span data-x="y">S</span>';
    expect(htmlText(selectHtml(html, "#price")!)).toBe("$12\ninner");
    expect(htmlText(selectHtml(html, "div.tag")!)).toBe("$12\ninner");
    expect(htmlText(selectHtml(html, "[data-x=y]")!)).toBe("S");
    expect(selectHtml(html, ".missing")).toBeNull();
    expect(parseSelector("div > p")).toBeNull();
    expect(parseSelector("")).toBeNull();
  });
});

describe("feeds", () => {
  it("reads RSS items", () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Shop news</title>
      <item><title>Sale on</title><link>https://shop.example/sale</link><guid>s1</guid><description>&lt;p&gt;Half price&lt;/p&gt;</description><pubDate>Fri, 30 Oct 2026 10:00:00 GMT</pubDate></item>
      <item><title>New stock</title><link>https://shop.example/new</link></item></channel></rss>`;
    const f = parseFeed(xml);
    expect(f.title).toBe("Shop news");
    expect(f.items.map((i) => i.id)).toEqual(["s1", "https://shop.example/new"]);
    expect(f.items[0].summary).toBe("Half price");
  });
  it("reads Atom entries and refuses other XML", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title><entry><id>urn:1</id><title>Hello</title><link rel="alternate" href="https://b.example/1"/><summary>Hi there</summary><updated>2026-10-30T10:00:00Z</updated></entry></feed>`;
    const f = parseFeed(xml);
    expect(f.items[0]).toMatchObject({ id: "urn:1", title: "Hello", link: "https://b.example/1", summary: "Hi there" });
    expect(() => parseFeed("<html><body>no</body></html>")).toThrow(/not an RSS or Atom feed/);
  });
});

describe("robots and the private network guard", () => {
  it("honours Disallow for every robot and for us", () => {
    const rules = robotsRules("User-agent: Googlebot\nDisallow: /g\n\nUser-agent: *\nDisallow: /private\nDisallow: /tmp*\n\nUser-agent: MultiesWatch\nDisallow: /nomulti");
    expect(robotsAllows(rules, "/pricing")).toBe(true);
    expect(robotsAllows(rules, "/private/x")).toBe(false);
    expect(robotsAllows(rules, "/tmpfile")).toBe(false);
    expect(robotsAllows(rules, "/nomulti")).toBe(false);
    expect(robotsAllows(rules, "/g")).toBe(true);
    expect(robotsAllows(robotsRules("User-agent: *\nDisallow:"), "/x")).toBe(true);
  });
  it("refuses private, local and odd addresses outside development", () => {
    const deps = { config: { mode: "production" } } as unknown as Deps;
    for (const bad of ["http://localhost/x", "http://127.0.0.1/", "http://10.0.0.5/", "http://192.168.1.1/", "http://169.254.169.254/latest", "http://[::1]/", "ftp://example.com/", "https://user:pw@example.com/", "not a url"]) {
      expect(() => checkWatchUrl(deps, bad), bad).toThrow();
    }
    expect(checkWatchUrl(deps, "https://example.com/pricing").hostname).toBe("example.com");
  });
});
