import { describe, it, expect, beforeEach } from "vitest";
import { applyIndex, dateRange, hasFilters, instantHits, NO_FILTERS, parseFilterWords, searchUrl, serverTypes, __test, type Filters, type IndexEntry } from "@/web/lib/search-r98";

/** R98: the command menu's side of search: filter words, date ranges, the URL, and the instant index. */

const people = [{ id: "u1", name: "Sam Mate", email: "sam@acme.io" }, { id: "u2", name: "Olive Owner", email: "olive@acme.io" }];
const projects = [{ id: "p1", name: "Harbour site", key: "HAR" }, { id: "p2", name: "Internal", key: "INT" }];

describe("filter words typed in the box", () => {
  it("turns type, from, in, after and before into filters and leaves the rest", () => {
    const r = parseFilterWords("budget type:docs from:sam in:har after:2026-10-01 before:2026-10-31", people, projects);
    expect(r.text).toBe("budget");
    expect(r.filters).toEqual({ type: "docs", person: { id: "u1", name: "Sam Mate" }, project: { id: "p1", name: "Harbour site" }, date: "custom", from: "2026-10-01", to: "2026-10-31" });
    expect(r.problems).toEqual([]);
  });
  it("matches people by email or a name start, projects by key or name, and quoted names", () => {
    expect(parseFilterWords("by:olive@acme.io x", people, projects).filters.person?.id).toBe("u2");
    expect(parseFilterWords('project:"internal" x', people, projects).filters.project?.id).toBe("p2");
  });
  it("names what it could not use, and keeps a bare colon word as text", () => {
    const r = parseFilterWords("plan from:zed type:videos after:soon", people, projects);
    expect(r.problems).toEqual(["No person called zed", "No type called videos", "Use a date like 2026-10-31 after after:"]);
    expect(r.text).toBe("plan");
    expect(parseFilterWords("ratio 16:9 from:", people, projects)).toMatchObject({ text: "ratio 16:9 from:", problems: [] });
  });
});

describe("dates and the request", () => {
  const now = new Date(2026, 10, 1, 9, 0); // 1 Nov 2026, local
  it("works out ranges in the person's own calendar", () => {
    expect(dateRange({ date: "today" }, now)).toEqual({ from: "2026-11-01", to: "2026-11-01" });
    expect(dateRange({ date: "7d" }, now)).toEqual({ from: "2026-10-26", to: "2026-11-01" });
    expect(dateRange({ date: "30d" }, now).from).toBe("2026-10-03");
    expect(dateRange({ date: "any" }, now)).toEqual({ from: null, to: null });
    expect(dateRange({ date: "custom", from: "2026-01-01", to: null }, now)).toEqual({ from: "2026-01-01", to: null });
  });
  it("sends only what is set, and contacts brings deals, mail brings attachments", () => {
    expect(searchUrl("plan", NO_FILTERS)).toBe("/search?q=plan");
    const f: Filters = { type: "contacts", person: { id: "u1", name: "Sam" }, project: { id: "p1", name: "H" }, date: "custom", from: "2026-10-01", to: null };
    expect(searchUrl("a b", f, true)).toBe("/search?q=a+b&types=contacts%2Cdeals&person=u1&project=p1&from=2026-10-01&strict=1");
    expect(serverTypes("mail")).toEqual(["mail", "attachments"]);
    expect(hasFilters(NO_FILTERS)).toBe(false);
    expect(hasFilters({ ...NO_FILTERS, date: "today" })).toBe(true);
  });
});

describe("the instant index", () => {
  const e = (type: IndexEntry["type"], id: string, title: string, extra: Partial<IndexEntry> = {}): IndexEntry => ({ type, id, title, subtitle: "", url: `/x/${id}`, at: "2026-10-30T10:00:00.000Z", ...extra });
  let store: { owner: string; mini: ReturnType<typeof __test.newMini>; byKey: Map<string, IndexEntry>; loadedAt: number; buildMs: number; loading: null };
  beforeEach(() => {
    store = { owner: "u:o", mini: __test.newMini(), byKey: new Map(), loadedAt: Date.now(), buildMs: 0, loading: null };
    __test.setStore(store);
  });

  it("finds titles with a typo and by a word start, and ranks the closer one first", () => {
    applyIndex(store, [e("tasks", "t1", "Quarterly invoice review", { keys: "OPS-12" }), e("docs", "d1", "Invoicing guide"), e("contacts", "c1", "Ivy Nguyen")]);
    expect(instantHits("invoce", NO_FILTERS).map((x) => x.id)).toContain("t1");
    expect(instantHits("quart", NO_FILTERS).map((x) => x.id)).toEqual(["t1"]);
    expect(instantHits("ops-12", NO_FILTERS).map((x) => x.id)).toEqual(["t1"]);
    expect(instantHits("q", NO_FILTERS)).toEqual([]);
    expect(instantHits("zzzzzz", NO_FILTERS)).toEqual([]);
  });

  it("applies type, project, person and date filters", () => {
    applyIndex(store, [
      e("tasks", "t1", "Heron copy", { projectId: "p1", personId: "u1" }), e("tasks", "t2", "Heron photos", { projectId: "p2", personId: "u2" }),
      e("docs", "d1", "Heron brief", { projectId: "p1", at: "2025-01-01T00:00:00.000Z" }), e("files", "f1", "heron.png"),
    ]);
    expect(instantHits("heron", { ...NO_FILTERS, type: "docs" }).map((x) => x.id)).toEqual(["d1"]);
    expect(instantHits("heron", { ...NO_FILTERS, project: { id: "p1", name: "" } }).map((x) => x.id).sort()).toEqual(["d1", "t1"]);
    expect(instantHits("heron", { ...NO_FILTERS, person: { id: "u2", name: "" } }).map((x) => x.id)).toEqual(["t2"]);
    expect(instantHits("heron", { ...NO_FILTERS, date: "custom", from: "2026-01-01" }).map((x) => x.id)).not.toContain("d1");
  });

  it("updates in place: adds, renames and removes, so lost access drops out on the next refresh", () => {
    expect(applyIndex(store, [e("tasks", "t1", "Alpha plan"), e("channels", "c1", "#board")])).toEqual({ added: 2, changed: 0, removed: 0 });
    expect(applyIndex(store, [e("tasks", "t1", "Beta plan")])).toEqual({ added: 0, changed: 1, removed: 1 });
    expect(instantHits("alpha", NO_FILTERS)).toEqual([]);
    expect(instantHits("beta", NO_FILTERS).map((x) => x.id)).toEqual(["t1"]);
    expect(instantHits("board", NO_FILTERS)).toEqual([]);
  });

  it("is empty with no index (signed out or another workspace)", () => {
    __test.setStore(null);
    expect(instantHits("anything", NO_FILTERS)).toEqual([]);
  });
});
