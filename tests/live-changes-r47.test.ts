import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { MemoryChatHub, type ChatLiveBus, type HubConn } from "@/server/realtime/hub";
import { notifyLiveChanges, resetLiveChanges, PUBLISH_WAIT_MS } from "@/server/realtime/changes-live-r47";
import { LiveChanges, listPollMs, LIVE_LIST_POLL_MS } from "@/web/lib/live-changes-r47";
import { behind, POLL_MS } from "@/web/pages/app/work/paged-tasks-r46";
import type { LiveChatConnection } from "@/web/lib/live-chat";
import type { Deps } from "@/server/context";

/** R47 (MB-139): open task lists hear the change feed's new position over the live socket. */

function socket(userId: string) {
  const frames: { t: string; cursor?: number }[] = [];
  const c: HubConn = { userId, openedAt: Date.now(), send: (d) => frames.push(JSON.parse(d)), close: () => undefined };
  return { c, frames, changes: () => frames.filter((f) => f.t === "changes") };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("live change pushes from the app", () => {
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  let owner: Client;
  let hub: MemoryChatHub;
  let orgId = "";
  beforeEach(async () => {
    resetLiveChanges();
    ctx = await makeTestApp();
    hub = new MemoryChatHub();
    ctx.deps.chatLive = hub;
    owner = new Client(ctx.app);
    await owner.signup("owner@acme.io", "Olive Owner");
    orgId = (await owner.get("/api/account/me")).body.organization.id;
  });

  it("a task write pushes the feed position the change feed then reports, with no task data", async () => {
    const s = socket("someone"); hub.join(orgId, s.c);
    const created = await owner.post("/api/tasks", { title: "Ship live boards" });
    expect(created.status).toBe(201);
    await sleep(5);
    const pushed = s.changes();
    expect(pushed.length).toBeGreaterThanOrEqual(1);
    const last = pushed[pushed.length - 1];
    expect(Object.keys(last).sort()).toEqual(["cursor", "t"]);
    const feed = (await owner.get("/api/changes?since=0&limit=500")).body;
    expect(last.cursor).toBe(feed.cursor);
    expect(feed.changes.some((c: { id: string }) => c.id === created.body.task.id)).toBe(true);
    // An edit moves it on.
    await owner.patch(`/api/tasks/${created.body.task.id}`, { title: "Ship live boards today" });
    await sleep(5);
    expect(s.changes().at(-1)!.cursor).toBeGreaterThan(last.cursor!);
  });

  it("another workspace hears nothing", async () => {
    const other = socket("x"); hub.join("org_other", other.c);
    await owner.post("/api/tasks", { title: "Private to us" });
    await sleep(5);
    expect(other.changes()).toEqual([]);
  });

  it("a hub that fails or hangs never fails or holds a write", async () => {
    ctx.deps.chatLive = { publish: async () => { throw new Error("hub down"); } };
    expect((await owner.post("/api/tasks", { title: "Still saves" })).status).toBe(201);
    resetLiveChanges();
    ctx.deps.chatLive = { publish: () => new Promise(() => undefined) };
    const t0 = Date.now();
    expect((await owner.post("/api/tasks", { title: "Still quick" })).status).toBe(201);
    expect(Date.now() - t0).toBeLessThan(PUBLISH_WAIT_MS * 4 + 1500);
  });
});

describe("coalescing", () => {
  beforeEach(() => resetLiveChanges());
  function slowBus() {
    const sent: number[] = [];
    let release: (() => void) | null = null;
    const bus: ChatLiveBus = { publish: async (_o, _a, e) => { sent.push((e as { cursor: number }).cursor); await new Promise<void>((r) => { release = r; }); } };
    return { bus, sent, release: () => { const r = release; release = null; r?.(); } };
  }
  it("writes during a publish are folded into one more publish of the newest position", async () => {
    const b = slowBus();
    const deps = { chatLive: b.bus } as unknown as Deps;
    void notifyLiveChanges(deps, "o1", 10);
    for (const seq of [11, 12, 13]) await notifyLiveChanges(deps, "o1", seq);
    expect(b.sent).toEqual([10]);
    b.release(); await sleep(1);
    expect(b.sent).toEqual([10, 13]);
    b.release(); await sleep(1);
    expect(b.sent).toEqual([10, 13]);
  });
  it("a batch write with no known position pushes 0", async () => {
    const sent: number[] = [];
    const deps = { chatLive: { publish: async (_o: string, _a: unknown, e: { cursor: number }) => { sent.push(e.cursor); } } } as unknown as Deps;
    await notifyLiveChanges(deps, "o1", 0);
    await notifyLiveChanges(deps, "o1", 7);
    await notifyLiveChanges(deps, "o1", 5); // older than what was sent: nothing new
    expect(sent).toEqual([0, 7]);
  });
  it("does nothing without a hub", async () => {
    await expect(notifyLiveChanges({} as Deps, "o1", 3)).resolves.toBeUndefined();
  });
});

describe("the browser side", () => {
  it("a list is behind a pushed position past its own, and always behind 0", () => {
    expect(behind(undefined, 5)).toBe(true);
    expect(behind({ cursor: 5, fullAt: 0 }, 5)).toBe(false);
    expect(behind({ cursor: 5, fullAt: 0 }, 4)).toBe(false);
    expect(behind({ cursor: 5, fullAt: 0 }, 6)).toBe(true);
    expect(behind({ cursor: 5, fullAt: 0 }, 0)).toBe(true);
  });
  it("polls every 20 s while the socket is down and every 60 s while it is open", () => {
    expect(listPollMs(false, POLL_MS)).toBe(20_000);
    expect(listPollMs(true, POLL_MS)).toBe(LIVE_LIST_POLL_MS);
  });
  it("opens one socket for the first list, shares it, and closes it with the last", () => {
    let made = 0, stopped = 0;
    const fake = () => { made++; return { state: "open", subscribe: () => () => undefined, start: () => undefined, stop: () => { stopped++; } } as unknown as LiveChatConnection; };
    const lc = new LiveChanges(fake);
    const got: number[][] = [[], []];
    const a = lc.add((c) => got[0].push(c));
    const b = lc.add((c) => got[1].push(c));
    expect(made).toBe(1);
    expect(lc.live).toBe(true);
    lc.push(9);
    expect(got).toEqual([[9], [9]]);
    a();
    expect(stopped).toBe(0);
    b();
    expect(stopped).toBe(1);
    expect(lc.live).toBe(false);
  });
});
