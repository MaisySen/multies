/**
 * PRIV1b (MH1, MH2, MH3, MH5): the phone's data stays with one person and one workspace while requests are on their way.
 */
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SessionProvider, useSession } from "@/lib/session";
import { kv, memoryKV } from "@/lib/kv";
import { ApiError } from "@/api/errors";
import { cached } from "@/lib/offline";
import { clearUserData } from "@/lib/local-data";
import { CommandQueue, OTHER_WORKSPACE_TEXT, setCommandQueue, type Command } from "@/lib/command-queue";
import { resetToolRunCache, saveRun, useSavedRun } from "@/lib/tool-run";
import { useMessages, keys } from "@/lib/queries";
import { SampleTransport } from "@/sample/transport";
import type { Transport } from "@/api/transport";

jest.mock("expo-router", () => ({ router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() }, useLocalSearchParams: () => ({}), Stack: { Screen: () => null } }));

function deferred<T = void>() { let resolve!: (v: T) => void; const p = new Promise<T>((r) => { resolve = r; }); return { p, resolve }; }

describe("PRIV1b MH1: the offline queue stops at a workspace switch", () => {
  it("each command checks its own workspace when it is sent, not once per flush", async () => {
    const store = memoryKV();
    let current = "org_a";
    const sent: Command[] = [];
    const gate = deferred();
    const q = new CommandQueue(store, async (c) => { sent.push(c); if (sent.length === 1) await gate.p; }, () => current);
    await q.enqueue({ kind: "mail.action", messageId: "m1", action: "archive" });
    await q.enqueue({ kind: "mail.action", messageId: "m2", action: "archive" });
    const run = q.flush();
    await waitFor(() => expect(sent).toHaveLength(1));
    current = "org_b"; // the server moved on while the first was on its way
    gate.resolve();
    const r = await run;
    expect(sent.map((c) => (c as { messageId: string }).messageId)).toEqual(["m1"]);
    expect(r.rejected.map((x) => x.error.message)).toEqual([OTHER_WORKSPACE_TEXT]);
  });

  it("hold waits for the change in flight and sends nothing more; release sends again", async () => {
    const store = memoryKV();
    const sent: string[] = [];
    const gate = deferred();
    const q = new CommandQueue(store, async (c) => { sent.push((c as { messageId: string }).messageId); if (sent.length === 1) await gate.p; }, () => "org_a");
    await q.enqueue({ kind: "mail.action", messageId: "m1", action: "archive" });
    await q.enqueue({ kind: "mail.action", messageId: "m2", action: "archive" });
    const run = q.flush();
    await waitFor(() => expect(sent).toEqual(["m1"]));
    let held = false;
    const h = q.hold().then(() => { held = true; });
    await Promise.resolve();
    expect(held).toBe(false); // still waiting for m1
    gate.resolve();
    await h;
    expect((await run).stopped).toBe(true);
    expect(sent).toEqual(["m1"]);
    expect(q.size).toBe(1);
    expect((await q.flush()).sent).toBe(0);
    q.release();
    expect((await q.flush()).sent).toBe(1);
    expect(sent).toEqual(["m1", "m2"]);
  });

  it("a clear while a change is on its way stops the flush and keeps a change queued after it", async () => {
    const store = memoryKV();
    const sent: string[] = [];
    const gate = deferred();
    const q = new CommandQueue(store, async (c) => { sent.push((c as { messageId: string }).messageId); if (sent.length === 1) await gate.p; }, () => "org_a");
    await q.enqueue({ kind: "mail.action", messageId: "m1", action: "archive" });
    await q.enqueue({ kind: "mail.action", messageId: "m2", action: "archive" });
    const run = q.flush();
    await waitFor(() => expect(sent).toEqual(["m1"]));
    await q.clear();
    await q.enqueue({ kind: "mail.action", messageId: "m3", action: "archive" });
    gate.resolve();
    await run;
    expect(sent).toEqual(["m1"]);
    expect(q.list().map((c) => (c as { messageId: string }).messageId)).toEqual(["m3"]);
  });
});

describe("PRIV1b MH1: switchWorkspace stops the queue before the server switch", () => {
  function res(status: number, body: unknown) { return { ok: status < 400, status, text: async () => JSON.stringify(body), headers: { get: () => null } }; }
  let active = "org_north";
  let switchStatus = 200;
  const events: string[] = [];
  beforeEach(async () => {
    active = "org_north"; switchStatus = 200; events.length = 0;
    resetToolRunCache();
    await kv().clear();
    const store = require("expo-secure-store");
    await store.setItemAsync("mymail.cookies", JSON.stringify({ "__Secure-mymail.session_token": "sess.sig" }));
    await store.setItemAsync("mymail.mode", "live");
    global.fetch = jest.fn(async (url: string, init: { method: string }) => {
      const path = url.replace(/^https:\/\/[^/]+/, "");
      if (path.endsWith("/account/me")) return res(200, { user: { id: "u", email: "a@b.au", name: "A", emailVerified: true, twoFactor: false, platformAdmin: false }, organization: { id: active, name: active, plan: "free", isDemo: false, role: "owner", timezone: "UTC", country: "AU" } });
      const m = path.match(/\/account\/workspaces\/([^/]+)\/switch$/);
      if (m && init.method === "POST") {
        events.push("switch");
        if (switchStatus !== 200) return res(switchStatus, { error: "boom", message: "Something went wrong." });
        active = m[1]; return res(200, { ok: true, workspace: { id: m[1], name: m[1] } });
      }
      return res(404, {});
    }) as unknown as typeof fetch;
  });
  afterEach(() => setCommandQueue(null));
  const wrapper = ({ children }: { children: ReactNode }) => <SessionProvider>{children}</SessionProvider>;

  async function queueWithTwo() {
    const gate = deferred();
    const q = new CommandQueue(kv(), async (c) => { events.push(`send ${(c as { messageId: string }).messageId}`); if (events.filter((e) => e.startsWith("send")).length === 1) await gate.p; }, () => "org_north");
    await q.enqueue({ kind: "mail.action", messageId: "m1", action: "archive" });
    await q.enqueue({ kind: "mail.action", messageId: "m2", action: "archive" });
    setCommandQueue(q);
    return { q, gate };
  }

  it("the change in flight lands before the switch, and nothing from the old workspace is sent after it", async () => {
    const { result } = await renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(result.current.me?.organization?.id).toBe("org_north"));
    const { q, gate } = await queueWithTwo();
    const run = q.flush();
    await waitFor(() => expect(events).toEqual(["send m1"]));
    let done: Promise<void> = Promise.resolve();
    await act(async () => { done = result.current.switchWorkspace("org_south"); await Promise.resolve(); });
    expect(events).toEqual(["send m1"]); // the switch waits for m1
    gate.resolve();
    await act(async () => { await done; await run; });
    expect(events).toEqual(["send m1", "switch"]);
    await q.flush();
    expect(events).toEqual(["send m1", "switch"]);
    expect(q.size).toBe(0);
    expect(result.current.me?.organization?.id).toBe("org_south");
  });

  it("a switch the server refuses keeps the waiting changes and sends them again", async () => {
    switchStatus = 500;
    const { result } = await renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(result.current.me?.organization?.id).toBe("org_north"));
    const { q, gate } = await queueWithTwo();
    gate.resolve();
    await act(async () => { await expect(result.current.switchWorkspace("org_south")).rejects.toBeTruthy(); });
    expect(q.size).toBe(2);
    expect((await q.flush()).sent).toBe(2);
  });
});

describe("PRIV1b MH2: an answer that arrives after a clear is not saved", () => {
  it("a fetch for the old workspace that returns after the clear writes nothing back", async () => {
    const store = memoryKV();
    const gate = deferred<{ v: string }>();
    const pending = cached(store, "list:live:inbox:all", () => gate.p);
    await clearUserData("workspace", store, () => []);
    gate.resolve({ v: "workspace A mail" });
    expect(await pending).toEqual({ v: "workspace A mail" }); // the screen that asked still gets its answer
    await new Promise((r) => setTimeout(r, 0));
    expect(await store.get("list:live:inbox:all")).toBeNull();
  });

  it("without a clear it is saved as before", async () => {
    const store = memoryKV();
    await cached(store, "list:live:inbox:all", async () => ({ v: "mail" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse((await store.get("list:live:inbox:all"))!).v).toEqual({ v: "mail" });
  });
});

describe("PRIV1b MH3: clearing drops the tool run from a mounted Tools screen", () => {
  it("useSavedRun goes to null when the data is cleared", async () => {
    resetToolRunCache();
    const store = memoryKV();
    await saveRun({ token: "tok", op: "redact", name: "payslip.pdf", at: Date.now() }, store);
    const { result } = await renderHook(() => useSavedRun());
    expect(result.current?.name).toBe("payslip.pdf");
    await act(async () => { await clearUserData("workspace", store, () => []); });
    expect(result.current).toBeNull();
  });
});

describe("PRIV1b MH5: the offline unified inbox keeps only mailboxes in the overview", () => {
  const m = (id: string, mailboxId: string) => ({ id, mailboxId, subject: id, snippet: "", from: { address: "a@b.au" }, to: [], date: "2026-10-20" });
  const page = { messages: [m("m1", "mb_team"), m("m2", "mb_revoked")], nextCursor: null };
  function transport(offline: boolean): Transport {
    const s = new SampleTransport();
    return { kind: "sample", request: async (method, path, body, opts) => {
      if (path.startsWith("/mail/messages?")) { if (offline) throw new ApiError(0, "network", "offline"); return page as never; }
      return s.request(method, path, body, opts);
    } };
  }
  async function inbox(t: Transport, overview?: string[]) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    if (overview) qc.setQueryData(keys.overview, { mailboxes: overview.map((id) => ({ id })) });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}><SessionProvider transportOverride={t}>{children}</SessionProvider></QueryClientProvider>;
    const { result } = await renderHook(() => useMessages("inbox"), { wrapper });
    await waitFor(() => expect(result.current.data).toBeTruthy());
    return result.current.data!.pages[0].messages.map((x) => x.id);
  }
  beforeEach(async () => {
    await kv().clear();
    await kv().set("list:live:inbox:all", JSON.stringify({ at: 1, v: page }));
  });

  it("offline, mail from a mailbox no longer in the overview is not shown", async () => {
    expect(await inbox(transport(true), ["mb_team"])).toEqual(["m1"]);
    expect(await inbox(transport(true), ["mb_team", "mb_revoked"])).toEqual(["m1", "m2"]);
  });

  it("offline with no overview loaded it uses the saved one, and nothing when none is saved", async () => {
    expect(await inbox(transport(true))).toEqual([]);
    await kv().set("meta:live:overview", JSON.stringify({ v: { mailboxes: [{ id: "mb_team" }] } }));
    expect(await inbox(transport(true))).toEqual(["m1"]);
  });

  it("online the server's page is shown as it is", async () => {
    expect(await inbox(transport(false), ["mb_team"])).toEqual(["m1", "m2"]);
  });
});
