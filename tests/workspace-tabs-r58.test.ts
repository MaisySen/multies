import { describe, expect, it, vi } from "vitest";
import { blockedMessage, createWorkspaceTabs, parseNote, STORAGE_KEY, writeAllowedWhileBehind, type WorkspaceTabsEnv } from "@/web/lib/workspace-tabs-r58";

/** R58 (MB-245): tabs of one browser tell each other which workspace is open; a tab left behind stops its writes. */

/** An in-memory "browser": every tab gets a channel end; a post reaches every other end (like BroadcastChannel). */
function browser(opts: { channel?: boolean } = { channel: true }) {
  const ends: { f: (e: { data: unknown }) => void; tab: number }[] = [];
  const storageFs: { f: (k: string | null, v: string | null) => void; tab: number }[] = [];
  const store = new Map<string, string>();
  let n = 0;
  const tab = (id: string) => {
    const me = ++n;
    const env: WorkspaceTabsEnv = {
      tabId: id,
      channel: opts.channel === false ? null : {
        postMessage: (m) => { for (const e of ends) if (e.tab !== me) e.f({ data: structuredClone(m) }); },
        addEventListener: (_t, f) => { ends.push({ f, tab: me }); },
      },
      // The storage event fires in the other tabs only, as in browsers.
      storage: { setItem: (k, v) => { store.set(k, v); for (const s of storageFs) if (s.tab !== me) s.f(k, v); } },
      onStorage: (f) => { storageFs.push({ f, tab: me }); },
    };
    return createWorkspaceTabs(env);
  };
  return { tab, store };
}

describe("workspace across tabs (R58 MB-245)", () => {
  it("a tab still on the old workspace becomes behind when another tab opens a different one", () => {
    const b = browser();
    const one = b.tab("one"); const two = b.tab("two");
    one.adopt("org_a", "North"); two.adopt("org_a", "North");
    expect(one.behind()).toBeNull();
    const seen = vi.fn(); one.subscribe(seen);
    two.switchedHere(); two.adopt("org_b", "South");
    expect(one.behind()).toEqual({ orgId: "org_b", name: "South" });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(two.behind()).toBeNull(); // the tab that switched is up to date
  });

  it("stops writes in the behind tab before they are sent, and lets reads, switching and sign out through", () => {
    const b = browser();
    const one = b.tab("one"); const two = b.tab("two");
    one.adopt("org_a", "North"); two.switchedHere(); two.adopt("org_b", "South");
    expect(one.blockWrite("POST", "/tasks")).toBe("You switched to South in another tab. Reload to keep working here.");
    for (const m of ["PATCH", "PUT", "DELETE"]) expect(one.blockWrite(m, "/tasks/tsk_1")).toBeTruthy();
    expect(one.blockWrite("GET", "/tasks")).toBeNull();
    expect(one.blockWrite("POST", "/account/workspaces/org_a/switch")).toBeNull();
    expect(one.blockWrite("POST", "/account/workspaces")).toBeNull();
    expect(one.blockWrite("POST", "/auth/sign-out")).toBeNull();
    expect(two.blockWrite("POST", "/tasks")).toBeNull();
  });

  it("a refetch in the behind tab does not hide the banner; switching back or switching here clears it", () => {
    const b = browser();
    const one = b.tab("one"); const two = b.tab("two");
    one.adopt("org_a", "North"); two.switchedHere(); two.adopt("org_b", "South");
    one.adopt("org_b", "South"); // the behind tab's account read now shows the server's workspace
    expect(one.behind()?.orgId).toBe("org_b");
    two.switchedHere(); two.adopt("org_a", "North"); // the other tab goes back to the workspace this one shows
    expect(one.behind()).toBeNull();
    two.switchedHere(); two.adopt("org_b", "South");
    expect(one.behind()?.orgId).toBe("org_b");
    one.switchedHere(); one.adopt("org_b", "South"); // a switch made in this tab brings it up to date
    expect(one.behind()).toBeNull();
    expect(two.behind()).toBeNull(); // the same workspace: nobody is behind
  });

  it("works through the storage event when the browser has no BroadcastChannel", () => {
    const b = browser({ channel: false });
    const one = b.tab("one"); const two = b.tab("two");
    one.adopt("org_a", "North"); two.switchedHere(); two.adopt("org_b", "South");
    expect(one.behind()).toEqual({ orgId: "org_b", name: "South" });
    expect(parseNote(b.store.get(STORAGE_KEY))?.orgId).toBe("org_b");
  });

  it("a tab that has not loaded its workspace yet, its own messages and broken messages change nothing", () => {
    const one = createWorkspaceTabs({ tabId: "one" });
    one.receive({ orgId: "org_b", name: "South", tab: "two", at: 1 }); // nothing shown yet
    expect(one.behind()).toBeNull();
    one.adopt("org_a", "North");
    one.receive({ orgId: "org_b", name: "South", tab: "one", at: 1 });
    one.receive("not json"); one.receive({ name: "x" }); one.receive(null);
    expect(one.behind()).toBeNull();
    one.receive(JSON.stringify({ orgId: "org_b", name: "South", tab: "two", at: 2 }));
    expect(one.behind()?.name).toBe("South");
  });

  it("does not announce the same workspace twice and survives a channel that throws", () => {
    const post = vi.fn(() => { throw new Error("closed"); });
    const setItem = vi.fn();
    const one = createWorkspaceTabs({ tabId: "one", channel: { postMessage: post, addEventListener: () => {} }, storage: { setItem } });
    one.adopt("org_a", "North"); one.adopt("org_a", "North");
    expect(post).toHaveBeenCalledTimes(1);
    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it("plain words, and which paths a behind tab may still write", () => {
    expect(blockedMessage("")).toBe("You switched to another workspace in another tab. Reload to keep working here.");
    expect(blockedMessage("South")).not.toMatch(/[\u2013\u2014]/);
    expect(writeAllowedWhileBehind("/account/workspaces/x/switch")).toBe(true);
    expect(writeAllowedWhileBehind("/account/preferences")).toBe(false);
    expect(writeAllowedWhileBehind("/tasks")).toBe(false);
  });
});
