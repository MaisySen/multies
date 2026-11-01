import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { builtinLayout, isSafeLinkUrl, moveItem, normalizeLayout, WIDGET_IDS, HomeLayout } from "@/shared/home-widgets-r131";
import { availableWidgets } from "@/server/services/home-widgets-r131";

describe("R131 home widgets: layout rules", () => {
  it("built in default shows the day first and hides the optional widgets", () => {
    const l = builtinLayout();
    expect(l.items.map((i) => i.id)).toEqual([...WIDGET_IDS]);
    expect(l.items.filter((i) => !i.hidden).map((i) => i.id)).toEqual(["tasks", "calendar", "inbox", "links", "overview"]);
  });
  it("normalize drops unknown and unavailable widgets, keeps order, appends missing ones hidden", () => {
    const l = normalizeLayout({ v: 1, items: [{ id: "inbox", size: "wide" }, { id: "social", size: "small" }, { id: "tasks", size: "small" }], links: [] }, ["tasks", "inbox", "links"]);
    expect(l.items).toEqual([{ id: "inbox", size: "wide" }, { id: "tasks", size: "small" }, { id: "links", size: "small", hidden: true }]);
  });
  it("normalize falls back to the built in layout on junk", () => {
    expect(normalizeLayout("nope", WIDGET_IDS)).toEqual(builtinLayout());
    expect(normalizeLayout({ v: 1, items: [{ id: "tasks", size: "huge" }] }, WIDGET_IDS)).toEqual(builtinLayout());
  });
  it("rejects a widget listed twice", () => {
    expect(HomeLayout.safeParse({ v: 1, items: [{ id: "tasks", size: "small" }, { id: "tasks", size: "wide" }], links: [] }).success).toBe(false);
  });
  it("moves one place and ignores moves past either end", () => {
    const items = builtinLayout().items;
    expect(moveItem(items, "calendar", -1).map((i) => i.id).slice(0, 2)).toEqual(["calendar", "tasks"]);
    expect(moveItem(items, "tasks", -1)).toBe(items);
    expect(moveItem(items, "dashboards", 1)).toBe(items);
  });
  it("quick links take http and https only", () => {
    expect(isSafeLinkUrl("https://example.com/a?b=1")).toBe(true);
    expect(isSafeLinkUrl("http://intranet.local")).toBe(true);
    for (const bad of ["javascript:alert(1)", "data:text/html,hi", "ftp://x.y", "https://user:pw@example.com", "not a url", `https://e.com/${"a".repeat(600)}`]) expect(isSafeLinkUrl(bad)).toBe(false);
  });
  it("social and feeds are offered only where those areas are on", () => {
    expect(availableWidgets({ config: { socialP2b: false, flows: false } } as never)).not.toContain("social");
    expect(availableWidgets({ config: { socialP2b: false, flows: false } } as never)).not.toContain("feeds");
    expect(availableWidgets({ config: {} } as never)).toEqual([...WIDGET_IDS]);
  });
});

describe("R131 home widgets: routes", () => {
  let owner: Client; let member: Client; let other: Client;
  beforeEach(async () => {
    const ctx = await makeTestApp({ HOME_WIDGETS_R131: "on" } as never);
    owner = new Client(ctx.app);
    await owner.signup("owner@acme.io", "Olive Owner");
    const invite = await owner.post("/api/team/invites", { email: "max@acme.io", role: "member" });
    member = new Client(ctx.app);
    await member.signup("max@acme.io", "Max Member", "");
    expect((await member.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    other = new Client(ctx.app);
    await other.signup("zed@other.io", "Zed Other");
  });
  const mine = { v: 1, items: [{ id: "inbox", size: "wide" }, { id: "tasks", size: "small" }], links: [{ id: "a1", title: "Handbook", url: "https://example.com/handbook" }] };

  it("a new person gets the built in layout; saving, reading back and reset work", async () => {
    let r = await member.get("/api/home-widgets");
    expect(r.status).toBe(200);
    expect(r.body.source).toBe("builtin");
    expect(r.body.canSetDefault).toBe(false);
    r = await member.put("/api/home-widgets", mine);
    expect(r.status).toBe(200);
    expect(r.body.source).toBe("mine");
    expect(r.body.layout.items[0]).toEqual({ id: "inbox", size: "wide" });
    expect(r.body.layout.links).toHaveLength(1);
    r = await member.get("/api/home-widgets");
    expect(r.body.layout.items.slice(0, 2).map((i: { id: string }) => i.id)).toEqual(["inbox", "tasks"]);
    r = await member.del("/api/home-widgets");
    expect(r.body.source).toBe("builtin");
  });
  it("refuses unsafe quick links on the server", async () => {
    const r = await member.put("/api/home-widgets", { ...mine, links: [{ id: "x", title: "Bad", url: "javascript:alert(1)" }] });
    expect(r.status).toBe(422);
  });
  it("only owners and admins set the workspace default; members then see it until they arrange their own", async () => {
    expect((await member.put("/api/home-widgets/default", mine)).status).toBe(403);
    expect((await member.del("/api/home-widgets/default")).status).toBe(403);
    const r = await owner.put("/api/home-widgets/default", mine);
    expect(r.status).toBe(200);
    const m = await member.get("/api/home-widgets");
    expect(m.body.source).toBe("workspace");
    expect(m.body.layout.items[0].id).toBe("inbox");
    expect(m.body.layout.links).toEqual([]); // links stay personal
    await member.put("/api/home-widgets", { ...mine, items: [{ id: "calendar", size: "wide" }] });
    expect((await member.get("/api/home-widgets")).body.layout.items[0].id).toBe("calendar");
    await owner.del("/api/home-widgets/default");
    await member.del("/api/home-widgets");
    expect((await member.get("/api/home-widgets")).body.source).toBe("builtin");
  });
  it("nothing crosses workspaces", async () => {
    await owner.put("/api/home-widgets/default", mine);
    await owner.put("/api/home-widgets", mine);
    const r = await other.get("/api/home-widgets");
    expect(r.body.source).toBe("builtin");
    expect(r.body.layout.links).toEqual([]);
  });
  it("signed out gets 401", async () => {
    const ctx = await makeTestApp({ HOME_WIDGETS_R131: "on" } as never);
    expect((await new Client(ctx.app).get("/api/home-widgets")).status).toBe(401);
  });
});

describe("R131 home widgets: flag off", () => {
  it("the route does not exist and config says off", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("a@b.io", "A B");
    expect((await c.get("/api/home-widgets")).status).toBe(404);
  });
});
