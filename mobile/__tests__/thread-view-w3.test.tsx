import { fireEvent, render, renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ApiError } from "@/api/errors";

/**
 * Wave 3: the thread screen gets partial data from the phone's saved copy (cached() returns the saved JSON
 * as is), from list prefetches and from older servers whose to/cc columns hold plain strings. A lenient
 * normalizeThreadView fixes the fields up; only a view with no message id is refused. The screen and the
 * offline check both use it, and a failure shows translated text with Try again and Back.
 */
jest.mock("@/components/thread-team", () => ({ ThreadTeam: () => null }));
jest.mock("expo-router", () => ({ router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) }, useLocalSearchParams: () => ({ id: "m1" }), Stack: { Screen: () => null } }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }), SafeAreaView: ({ children }: { children: ReactNode }) => children }));
jest.mock("@/components/meetings", () => ({ StartMeetingButton: () => null }));

describe("normalizeThreadView", () => {
  const { normalizeThreadView } = require("@/lib/thread-view") as typeof import("@/lib/thread-view");

  it("refuses only a view with no message or no message id", () => {
    expect(normalizeThreadView(undefined)).toBeNull();
    expect(normalizeThreadView(null)).toBeNull();
    expect(normalizeThreadView("x")).toBeNull();
    expect(normalizeThreadView({})).toBeNull();
    expect(normalizeThreadView({ message: null, thread: [] })).toBeNull();
    expect(normalizeThreadView({ message: {}, thread: [] })).toBeNull();
    expect(normalizeThreadView({ message: { id: 7 } })).toBeNull();
    expect(normalizeThreadView({ message: { id: "" } })).toBeNull();
    expect(normalizeThreadView({ message: { id: "m1" } })).not.toBeNull();
  });

  it("fixes up addresses: a string becomes { address }, null becomes an empty address, bad items go", () => {
    const v = normalizeThreadView({ message: { id: "m1", from: "ann@example.com", to: ["bob@example.com", null, 5, { address: "cy@example.com", name: "Cy" }, { name: "no address" }], cc: "dee@example.com" } })!;
    expect(v.message.from).toEqual({ address: "ann@example.com" });
    expect(v.message.to).toEqual([{ address: "bob@example.com" }, { address: "cy@example.com", name: "Cy" }]);
    expect(v.message.cc).toEqual([]);
    expect(v.message.bcc).toEqual([]);
    expect(normalizeThreadView({ message: { id: "m1", from: null } })!.message.from).toEqual({ address: "" });
    expect(normalizeThreadView({ message: { id: "m1", from: { name: "Only a name" } } })!.message.from).toEqual({ address: "", name: "Only a name" });
  });

  it("non array to, cc and attachments become empty lists; bad attachments go", () => {
    const v = normalizeThreadView({ message: { id: "m1", to: "x", cc: { a: 1 }, attachments: [null, { filename: "no id" }, { id: "a1", filename: "q.pdf", contentType: "application/pdf", sizeBytes: 10, available: true }] } })!;
    expect(v.message.to).toEqual([]);
    expect(v.message.cc).toEqual([]);
    expect(v.message.attachments).toEqual([{ id: "a1", filename: "q.pdf", contentType: "application/pdf", sizeBytes: 10, available: true }]);
    expect(normalizeThreadView({ message: { id: "m1", attachments: "nope" } })!.message.attachments).toEqual([]);
  });

  it("a missing, non array or empty thread becomes [message]; bad thread items go", () => {
    for (const thread of [undefined, null, "x", {}, [], [null, 3, {}]]) {
      const v = normalizeThreadView({ message: { id: "m1", subject: "Hi" }, thread })!;
      expect(v.thread.map((m) => m.id)).toEqual(["m1"]);
    }
    const v = normalizeThreadView({ message: { id: "m2" }, thread: [{ id: "m1", from: "a@b.au" }, "junk", { id: "m2", to: "c@d.au" }] })!;
    expect(v.thread.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(v.thread[0].from).toEqual({ address: "a@b.au" });
    expect(v.thread[1].to).toEqual([]);
  });

  it("non string subject, text and html become empty text or null; a bad date becomes empty", () => {
    const v = normalizeThreadView({ message: { id: "m1", subject: 4, text: null, html: { a: 1 }, date: "not a date", snippet: null } })!;
    expect(v.message.subject).toBe("");
    expect(v.message.text).toBe("");
    expect(v.message.html).toBeNull();
    expect(v.message.date).toBe("");
    expect(v.message.snippet).toBe("");
    const ok = normalizeThreadView({ message: { id: "m1", subject: "S", text: "T", html: "<p>H</p>", date: "2026-10-29T10:00:00Z", isStarred: true, threadId: "t1", mailboxId: "mb1" } })!;
    expect(ok.message).toMatchObject({ subject: "S", text: "T", html: "<p>H</p>", date: "2026-10-29T10:00:00Z", isStarred: true, threadId: "t1", mailboxId: "mb1" });
  });

  it("a whole, well formed view comes back with the same content", () => {
    const m = { id: "m1", threadId: "t1", mailboxId: "mb1", folder: "inbox", from: { address: "a@b.au", name: "A" }, to: [{ address: "c@d.au" }], cc: [], bcc: [], subject: "S", snippet: "s", date: "2026-10-29T10:00:00Z",
      isRead: true, isStarred: false, hasAttachments: false, replyTo: null, text: "T", html: null, attachments: [], sentByAgentId: null, labels: ["x"] };
    expect(normalizeThreadView({ message: m, thread: [m] })).toEqual({ message: m, thread: [m] });
  });
});

describe("the thread screen with partial data", () => {
  let mockQuery: { data: unknown; isPending?: boolean; error: unknown; refetch: jest.Mock };
  jest.mock("@/lib/queries", () => ({
    useThread: () => mockQuery,
    useAgents: () => ({ data: [] }),
    useMessageAction: () => ({ mutate: jest.fn(), isPending: false }),
    useTaskMutations: () => ({ fromEmail: { mutateAsync: jest.fn(), isPending: false } }),
  }));
  jest.mock("@/lib/offline", () => ({ ...jest.requireActual("@/lib/offline"), useOffline: () => false }));

  const screen = () => { const Thread = require("@/app/thread/[id]").default; return render(<Thread />); };

  it("renders a saved copy with string addresses, no cc, no attachments and no thread list", async () => {
    mockQuery = { data: { message: { id: "m1", subject: "Invoice", from: "ann@example.com", to: "bob@example.com", text: "Hello there" } }, error: null, refetch: jest.fn() };
    const s = await screen();
    expect(s.getByText("Invoice")).toBeTruthy();
    expect(s.getAllByText("ann@example.com").length).toBeGreaterThan(0);
    expect(s.getByText("Hello there")).toBeTruthy();
    expect(s.getByTestId("reply")).toBeTruthy();
    expect(s.queryByTestId("reply-all")).toBeNull();
  });

  it("renders thread items with null from, non array cc and a bad date", async () => {
    mockQuery = { data: { message: { id: "m2", subject: "Re" }, thread: [{ id: "m1", from: null, cc: "x", date: "nope", text: "first" }, { id: "m2", from: { address: "c@d.au" }, cc: [{ address: "e@f.au" }, "g@h.au"], to: [], text: "second", attachments: null }] }, error: null, refetch: jest.fn() };
    const s = await screen();
    expect(s.getByTestId("message-m2")).toBeTruthy();
    expect(s.getByTestId("collapsed-m1")).toBeTruthy();
    expect(s.getByTestId("reply-all")).toBeTruthy();
  });

  it("a view with no message id shows the translated error with Try again and Back, not the raw message", async () => {
    const refetch = jest.fn();
    mockQuery = { data: { message: {}, thread: [] }, error: null, refetch };
    const s = await screen();
    expect(s.getByText("Couldn't open this message")).toBeTruthy();
    await fireEvent.press(s.getByText("Try again"));
    expect(refetch).toHaveBeenCalled();
    await fireEvent.press(s.getByText("Back"));
    expect(require("expo-router").router.back).toHaveBeenCalled();
  });

  it("an error shows translated text, never the server's raw message", async () => {
    mockQuery = { data: undefined, error: new ApiError(500, "internal", "SQLITE_ERROR: no such column x at db.ts:12"), refetch: jest.fn() };
    const s = await screen();
    expect(s.getByText("Couldn't open this message")).toBeTruthy();
    expect(s.queryByText(/SQLITE_ERROR/)).toBeNull();
    mockQuery = { data: undefined, error: new ApiError(0, "network", "Can't reach Multies. Check your connection."), refetch: jest.fn() };
    const n = await screen();
    expect(n.getByText("Check your connection and try again.")).toBeTruthy();
    expect(n.queryByText("Can't reach Multies. Check your connection.")).toBeNull();
  });

  it("with no screen to go back to, Back opens the inbox", async () => {
    const r = require("expo-router").router;
    r.canGoBack.mockReturnValue(false);
    mockQuery = { data: undefined, error: new ApiError(404, "not_found", "Not found"), refetch: jest.fn() };
    const s = await screen();
    await fireEvent.press(s.getByText("Back to Inbox"));
    expect(r.replace).toHaveBeenCalledWith("/inbox");
    r.canGoBack.mockReturnValue(true);
  });
});

describe("the offline check uses the lenient view", () => {
  it("a saved copy with no message is refused as offline, not thrown as a TypeError; a partial one opens", async () => {
    const { kv } = require("@/lib/kv");
    const { setOffline } = require("@/lib/offline");
    const { SessionProvider } = require("@/lib/session");
    const { SampleTransport } = require("@/sample/transport");
    const { keys, useThread } = jest.requireActual("@/lib/queries");
    const offline = { kind: "sample" as const, request: async (m: never, p: string, b?: unknown, o?: never) => {
      if (p.startsWith("/account/me")) return new SampleTransport().request(m, p, b, o);
      throw new ApiError(0, "network", "offline");
    } };
    const setup = () => {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
      qc.setQueryData(keys.overview, { mailboxes: [{ id: "mb_team" }] });
      const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}><SessionProvider transportOverride={offline}>{children}</SessionProvider></QueryClientProvider>;
      return renderHook(() => useThread("t1"), { wrapper });
    };
    try {
      await kv().clear();
      await kv().set("thread:live:t1", JSON.stringify({ at: 1, v: { thread: [] } }));
      const bad = await setup();
      await waitFor(() => expect(bad.result.current.isError).toBe(true));
      expect((bad.result.current.error as ApiError).isNetwork).toBe(true);

      await kv().set("thread:live:t1", JSON.stringify({ at: 1, v: { message: { id: "t1", mailboxId: "mb_team", subject: "Pay slip", from: "hr@example.com" } } }));
      const ok = await setup();
      await waitFor(() => expect(ok.result.current.isSuccess).toBe(true));
      expect(ok.result.current.data?.message.from).toEqual({ address: "hr@example.com" });
      expect(ok.result.current.data?.thread.map((m: { id: string }) => m.id)).toEqual(["t1"]);
    } finally {
      setOffline(false);
      await kv().clear();
    }
  });
});
