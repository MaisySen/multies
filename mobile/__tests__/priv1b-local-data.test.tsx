import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SessionProvider, useSession } from "@/lib/session";
import { kv, memoryKV } from "@/lib/kv";
import { ApiError } from "@/api/errors";
import { cached, searchCache } from "@/lib/offline";
import { clearUserData, clearUserFiles, type CacheEntry } from "@/lib/local-data";
import { CommandQueue, QUEUE_KEY, QUEUE_WS_KEY, OTHER_WORKSPACE_TEXT, setCommandQueue, type Command } from "@/lib/command-queue";
import { loadRun, saveRun, resetToolRunCache } from "@/lib/tool-run";

jest.mock("expo-router", () => ({ router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() }, useLocalSearchParams: () => ({}), Stack: { Screen: () => null } }));

// PRIV1b (P53): sign out, a workspace switch and Clear saved mail leave nothing of the last person or workspace.
const PERSONAL = {
  "snoozed:live:inbox:mb_owner": "{\"v\":{\"items\":[{\"message\":{\"subject\":\"Payslip\"}}]}}",
  "tabs:live:all": "{}", "rules:live": "{}", "tools:run": "{\"token\":\"tok\",\"op\":\"redact\",\"at\":1}", "tools:recent": "[\"redact\"]",
  "search:recent": "[\"payslip\"]", "visits:plan": "{}", "pref:tasks:last-query": "salary", "list:live:inbox:all": "{}", "thread:live:m1": "{}",
};
const DEVICE = { "prefs:v1": "{}", "lock:on": "1", "inbox:tab": "primary" };

function fakeFolder(names: string[]) {
  const deleted: string[] = [];
  const entries: CacheEntry[] = names.map((name) => ({ name, delete: () => { deleted.push(name); } }));
  return { folder: () => entries, deleted };
}

describe("PRIV1b P53: one list of what the phone keeps per person and workspace", () => {
  it("sign out clears every personal key, the in-memory tool run, the queue and the downloaded files, and keeps device settings", async () => {
    const store = memoryKV({ ...PERSONAL, ...DEVICE, [QUEUE_KEY]: "[]", "tasks:v1": "[]" });
    await saveRun({ token: "tok", op: "redact", name: "a.pdf", at: Date.now() }, store);
    const f = fakeFolder(["drive", "tools", "DocumentPicker", "tools-upload-abc.bin", "fonts"]);
    await clearUserData("signOut", store, f.folder);
    for (const k of [...Object.keys(PERSONAL), QUEUE_KEY, "tasks:v1"]) expect(await store.get(k)).toBeNull();
    for (const [k, v] of Object.entries(DEVICE)) expect(await store.get(k)).toBe(v);
    expect(await loadRun(store)).toBeNull(); // the memory copy went too, not only the saved one
    expect(f.deleted.sort()).toEqual(["DocumentPicker", "drive", "tools", "tools-upload-abc.bin"]);
  });

  it("a workspace switch clears the same list and the waiting changes, in memory too", async () => {
    const store = memoryKV({ ...PERSONAL, ...DEVICE });
    const q = new CommandQueue(store, async () => {}, () => "org_a");
    await q.enqueue({ kind: "task.create", tempId: "tmp_1", input: { title: "Board notes" } });
    setCommandQueue(q);
    await clearUserData("workspace", store, () => []);
    setCommandQueue(null);
    for (const k of [...Object.keys(PERSONAL), QUEUE_KEY, QUEUE_WS_KEY]) expect(await store.get(k)).toBeNull();
    expect(q.size).toBe(0);
    expect(await store.get("prefs:v1")).toBe("{}");
  });

  it("Clear saved mail clears the same list but keeps changes waiting to sync", async () => {
    const store = memoryKV({ ...PERSONAL, [QUEUE_KEY]: "[1]" });
    const f = fakeFolder(["drive"]);
    await clearUserData("cache", store, f.folder);
    for (const k of Object.keys(PERSONAL)) expect(await store.get(k)).toBeNull();
    expect(await store.get(QUEUE_KEY)).toBe("[1]");
    expect(f.deleted).toEqual(["drive"]);
  });

  it("a file that can't be deleted does not stop the rest", () => {
    const deleted: string[] = [];
    clearUserFiles(() => [{ name: "drive", delete: () => { throw new Error("busy"); } }, { name: "tools", delete: () => { deleted.push("tools"); } }]);
    expect(deleted).toEqual(["tools"]);
  });
});

describe("PRIV1b P53: session clears through the shared list", () => {
  function res(status: number, body: unknown) { return { ok: status < 400, status, text: async () => JSON.stringify(body), headers: { get: () => null } }; }
  let active = "org_north";
  beforeEach(async () => {
    active = "org_north";
    resetToolRunCache();
    await kv().clear();
    const store = require("expo-secure-store");
    await store.setItemAsync("mymail.cookies", JSON.stringify({ "__Secure-mymail.session_token": "sess.sig" }));
    await store.setItemAsync("mymail.mode", "live");
    for (const [k, v] of Object.entries({ ...PERSONAL, ...DEVICE })) await kv().set(k, v);
    await kv().set(QUEUE_KEY, JSON.stringify([{ id: "cmd_1", at: 1, kind: "task.create", tempId: "tmp_1", input: { title: "x" }, ws: "org_north" }]));
    global.fetch = jest.fn(async (url: string, init: { method: string }) => {
      const path = url.replace(/^https:\/\/[^/]+/, "");
      if (path.endsWith("/account/me")) return res(200, { user: { id: "u", email: "a@b.au", name: "A", emailVerified: true, twoFactor: false, platformAdmin: false }, organization: { id: active, name: active, plan: "free", isDemo: false, role: "owner", timezone: "UTC", country: "AU" } });
      const m = path.match(/\/account\/workspaces\/([^/]+)\/switch$/);
      if (m && init.method === "POST") { active = m[1]; return res(200, { ok: true, workspace: { id: m[1], name: m[1] } }); }
      return res(404, {});
    }) as unknown as typeof fetch;
  });
  const wrapper = ({ children }: { children: ReactNode }) => <SessionProvider>{children}</SessionProvider>;

  it("switching workspace drops snoozed mail, tabs, rules, the tool run, searches and the queue", async () => {
    const { result } = await renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(result.current.me?.organization?.id).toBe("org_north"));
    await act(async () => { await result.current.switchWorkspace("org_south"); });
    expect(result.current.me?.organization?.id).toBe("org_south");
    for (const k of [...Object.keys(PERSONAL), QUEUE_KEY]) expect(await kv().get(k)).toBeNull();
    expect(await kv().get("lock:on")).toBe("1");
  });

  it("signing out drops the same keys", async () => {
    const { result } = await renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("signedIn"));
    await act(async () => { await result.current.signOut(); });
    expect(result.current.status).toBe("signedOut");
    for (const k of [...Object.keys(PERSONAL), QUEUE_KEY]) expect(await kv().get(k)).toBeNull();
    expect(await kv().get("prefs:v1")).toBe("{}");
  });
});

describe("PRIV1b P53: offline cache follows access", () => {
  it("a 403 or 404 removes the saved copy, so offline it is not served again", async () => {
    for (const status of [403, 404]) {
      const store = memoryKV();
      await cached(store, "thread:live:m1", async () => ({ thread: [] }));
      await expect(cached(store, "thread:live:m1", async () => { throw new ApiError(status, "x", "No"); })).rejects.toMatchObject({ status });
      expect(await store.get("thread:live:m1")).toBeNull();
      await expect(cached(store, "thread:live:m1", async () => { throw new ApiError(0, "network", "offline"); })).rejects.toMatchObject({ status: 0 });
    }
  });

  it("a server error or no connection keeps the saved copy", async () => {
    const store = memoryKV();
    await cached(store, "list:live:inbox:all", async () => ({ messages: [] }));
    await expect(cached(store, "list:live:inbox:all", async () => { throw new ApiError(503, "busy", "Busy"); })).rejects.toMatchObject({ status: 503 });
    expect(await cached(store, "list:live:inbox:all", async () => { throw new ApiError(0, "network", "offline"); })).toEqual({ messages: [] });
  });

  const m = (id: string, mailboxId: string, subject: string) => ({ id, mailboxId, subject, snippet: "", from: { address: "a@b.au" }, to: [], date: "2026-10-2" + id.slice(-1) });
  async function seeded() {
    const store = memoryKV();
    await store.set("list:live:inbox:all", JSON.stringify({ v: { messages: [m("m1", "mb_team", "Invoice team"), m("m2", "mb_revoked", "Invoice private")], nextCursor: null } }));
    await store.set("thread:live:m3", JSON.stringify({ v: { message: {}, thread: [{ ...m("m3", "mb_revoked", "Payslip"), text: "invoice attached" }] } }));
    return store;
  }

  it("offline search reads only mailboxes in the current overview", async () => {
    const store = await seeded();
    expect((await searchCache(store, "invoice", ["mb_team"])).map((h) => h.id)).toEqual(["m1"]);
    expect((await searchCache(store, "invoice", ["mb_team", "mb_revoked"])).map((h) => h.id).sort()).toEqual(["m1", "m2", "m3"]);
    expect(await searchCache(store, "invoice", [])).toEqual([]);
  });

  it("without a loaded overview it uses the saved one, and nothing when none is saved", async () => {
    const store = await seeded();
    expect(await searchCache(store, "invoice")).toEqual([]);
    await store.set("meta:live:overview", JSON.stringify({ v: { mailboxes: [{ id: "mb_team" }] } }));
    expect((await searchCache(store, "invoice")).map((h) => h.id)).toEqual(["m1"]);
  });
});

describe("PRIV1b P53: the offline queue stays in its workspace", () => {
  it("a change queued in one workspace is not sent in another, and is reported", async () => {
    const store = memoryKV();
    const seen: Command[] = [];
    const a = new CommandQueue(store, async (c) => { seen.push(c); return { realId: "t1" }; }, () => "org_a");
    await a.enqueue({ kind: "task.create", tempId: "tmp_1", input: { title: "Board notes" } });
    expect(JSON.parse((await store.get(QUEUE_KEY))!)[0].ws).toBe("org_a");
    const b = new CommandQueue(store, async (c) => { seen.push(c); return { realId: "t1" }; }, () => "org_b");
    const r = await b.flush();
    expect(seen).toEqual([]);
    expect(r.sent).toBe(0);
    expect(r.rejected[0].error.message).toBe(OTHER_WORKSPACE_TEXT);
    expect(b.size).toBe(0);
  });

  it("in its own workspace it is sent as before", async () => {
    const store = memoryKV();
    const seen: Command[] = [];
    const a = new CommandQueue(store, async (c) => { seen.push(c); }, () => "org_a");
    await a.enqueue({ kind: "mail.action", messageId: "m1", action: "archive" });
    const r = await new CommandQueue(store, async (c) => { seen.push(c); }, () => "org_a").flush();
    expect(r).toMatchObject({ sent: 1, rejected: [] });
    expect(seen).toHaveLength(1);
  });

  it("waits while the workspace is not known, and a change made then takes the last workspace seen", async () => {
    const store = memoryKV();
    await new CommandQueue(store, async () => {}, () => "org_a").load(); // the app saw org_a before going offline
    const seen: Command[] = [];
    const early = new CommandQueue(store, async (c) => { seen.push(c); }, () => null);
    await early.enqueue({ kind: "task.delete", taskId: "t9" });
    expect(await early.flush()).toMatchObject({ sent: 0, stopped: true });
    expect(seen).toEqual([]);
    const r = await new CommandQueue(store, async (c) => { seen.push(c); }, () => "org_a").flush();
    expect(r.sent).toBe(1);
  });
});
