/**
 * PRIV1b (MP1, MP2, MP3): the offline queue starts again after any workspace switch, a saved thread follows the
 * overview, and the app's queue checks the workspace of the latest render.
 */
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SessionProvider, useSession } from "@/lib/session";
import { kv } from "@/lib/kv";
import { ApiError } from "@/api/errors";
import { setOffline } from "@/lib/offline";
import { CommandQueue, QUEUE_KEY, commandQueue, setCommandQueue } from "@/lib/command-queue";
import { useCommandQueueRunner } from "@/components/sync-pill";
import { keys, useThread } from "@/lib/queries";
import { SampleTransport } from "@/sample/transport";

jest.mock("expo-router", () => ({ router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() }, useLocalSearchParams: () => ({}), Stack: { Screen: () => null } }));
jest.setTimeout(30_000);

function res(status: number, body: unknown) { return { ok: status < 400, status, text: async () => JSON.stringify(body), headers: { get: () => null } }; }

describe("PRIV1b live session with a workspace switch", () => {
  let active = "org_north";
  let meFailsAfterSwitch = false;
  beforeEach(async () => {
    active = "org_north"; meFailsAfterSwitch = false;
    setOffline(false);
    await kv().clear();
    const store = require("expo-secure-store");
    await store.setItemAsync("mymail.cookies", JSON.stringify({ "__Secure-mymail.session_token": "sess.sig" }));
    await store.setItemAsync("mymail.mode", "live");
    global.fetch = jest.fn(async (url: string, init: { method: string }) => {
      const path = url.replace(/^https:\/\/[^/]+/, "");
      if (path.endsWith("/account/me")) {
        if (meFailsAfterSwitch && active !== "org_north") return res(500, { error: "boom", message: "Something went wrong." });
        return res(200, { user: { id: "u", email: "a@b.au", name: "A", emailVerified: true, twoFactor: false, platformAdmin: false }, organization: { id: active, name: active, plan: "free", isDemo: false, role: "owner", timezone: "UTC", country: "AU" } });
      }
      const m = path.match(/\/account\/workspaces\/([^/]+)\/switch$/);
      if (m && init.method === "POST") { active = m[1]; return res(200, { ok: true, workspace: { id: m[1], name: m[1] } }); }
      return res(404, {});
    }) as unknown as typeof fetch;
  });
  afterEach(() => setCommandQueue(null));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}><SessionProvider>{children}</SessionProvider></QueryClientProvider>;

  async function signedIn() {
    const r = await renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(r.result.current.me?.organization?.id).toBe("org_north"));
    return r;
  }

  describe("MP1: the queue is released whatever happens after the switch", () => {
    it("a switch whose me() fails still lets later changes be sent", async () => {
      meFailsAfterSwitch = true;
      const { result } = await signedIn();
      const sent: string[] = [];
      const q = new CommandQueue(kv(), async (c) => { sent.push((c as { messageId: string }).messageId); }, () => "org_south");
      setCommandQueue(q);
      await act(async () => { await expect(result.current.switchWorkspace("org_south")).rejects.toBeInstanceOf(ApiError); });
      await q.enqueue({ kind: "mail.action", messageId: "m3", action: "archive" });
      const r = await q.flush();
      expect(r.stopped).toBe(false);
      expect(r.sent).toBe(1);
      expect(sent).toEqual(["m3"]);
    });

    it("a switch that works also leaves the queue sending, with nothing from the old workspace", async () => {
      const { result } = await signedIn();
      const sent: string[] = [];
      const q = new CommandQueue(kv(), async (c) => { sent.push((c as { messageId: string }).messageId); }, () => "org_south");
      await q.enqueue({ kind: "mail.action", messageId: "old", action: "archive" });
      setCommandQueue(q);
      await act(async () => { await result.current.switchWorkspace("org_south"); });
      expect(result.current.me?.organization?.id).toBe("org_south");
      expect(q.size).toBe(0);
      await q.enqueue({ kind: "mail.action", messageId: "new", action: "archive" });
      expect((await q.flush()).sent).toBe(1);
      expect(sent).toEqual(["new"]);
    });
  });

  describe("MP3: the app's queue reads the current workspace", () => {
    it("a queue made before a switch records and checks the workspace the app is in now", async () => {
      const { result } = await renderHook(() => ({ s: useSession(), run: useCommandQueueRunner() }), { wrapper });
      await waitFor(() => expect(result.current.s.me?.organization?.id).toBe("org_north"));
      await waitFor(() => expect(commandQueue()).not.toBeNull());
      const first = commandQueue()!;
      await act(async () => { await first.enqueue({ kind: "mail.action", messageId: "m1", action: "archive" }); });
      expect(JSON.parse((await kv().get(QUEUE_KEY))!)[0].ws).toBe("org_north");
      await act(async () => { await result.current.s.switchWorkspace("org_south"); });
      await waitFor(() => expect(result.current.s.me?.organization?.id).toBe("org_south"));
      // The old instance (a flush may still run on it) sees the new workspace, not the one it was made in.
      await act(async () => { await first.enqueue({ kind: "mail.action", messageId: "m2", action: "archive" }); });
      expect(first.list().map((c) => (c as { ws?: string }).ws)).toEqual(["org_south"]);
    });
  });
});

describe("PRIV1b MP2: a saved thread opens offline only while its mailbox is in the overview", () => {
  const thread = (mailboxId: string) => ({ message: { id: "t1", mailboxId, subject: "Pay slip", text: "secret" }, thread: [] });
  const offline = { kind: "sample" as const, request: async (m: never, p: string, b?: unknown, o?: never) => {
    if (p.startsWith("/account/me")) return new SampleTransport().request(m, p, b, o);
    throw new ApiError(0, "network", "offline");
  } } as unknown as SampleTransport;

  function setup(overview?: string[]) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    if (overview) qc.setQueryData(keys.overview, { mailboxes: overview.map((id) => ({ id })) });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}><SessionProvider transportOverride={offline}>{children}</SessionProvider></QueryClientProvider>;
    return renderHook(() => useThread("t1"), { wrapper });
  }

  beforeEach(async () => { await kv().clear(); });
  afterEach(() => setOffline(false));

  it("a thread from a mailbox no longer in the overview is not served from the phone", async () => {
    await kv().set("thread:live:t1", JSON.stringify({ at: 1, v: thread("mb_ended") }));
    const { result } = await setup(["mb_team"]);
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect((result.current.error as ApiError).isNetwork).toBe(true);
  });

  it("the saved overview decides when the app has none yet", async () => {
    await kv().set("thread:live:t1", JSON.stringify({ at: 1, v: thread("mb_ended") }));
    await kv().set("meta:live:overview", JSON.stringify({ at: 1, v: { mailboxes: [{ id: "mb_team" }] } }));
    const { result } = await setup();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it("a thread from a mailbox still in the overview opens offline", async () => {
    await kv().set("thread:live:t1", JSON.stringify({ at: 1, v: thread("mb_team") }));
    const { result } = await setup(["mb_team", "mb_shared"]);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.message.subject).toBe("Pay slip");
  });
});
