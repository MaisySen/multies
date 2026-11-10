/**
 * PRIV1b (mobile-mpar3): saved replies on the server's real path (P55), send later as an instant from the phone's own
 * zone (P56), selection ends on a mailbox or tab switch (P57), Calendar and bulk select details (P67), the sign in link
 * latch (P35) and the explicit list of pages that open in the phone's browser (P33).
 */
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ApiError } from "@/api/errors";
import type { Transport } from "@/api/transport";
import { SessionProvider, useSession } from "@/lib/session";
import { SampleTransport } from "@/sample/transport";
import { tr } from "@/i18n";
import { resetPrefsForTests } from "@/lib/startup-prefs";
import { BULK_MAX, allPickedOf, localMoment, localWhen, startOfDay } from "@/lib/mpar3";
import { useRenderSnippet, useSendLater, useSnippets } from "@/lib/mpar3-queries";
import { LINK_MISSING_MS, opensInSystemBrowser, resetWebLink, signedInUrl } from "@/lib/web-link";

jest.mock("expo-router", () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), navigate: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  useFocusEffect: (cb: () => void) => { require("react").useEffect(cb, [cb]); },
  Stack: { Screen: () => null },
  Link: ({ children }: { children: ReactNode }) => children,
}));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }), SafeAreaView: ({ children }: { children: ReactNode }) => children }));
jest.setTimeout(60_000);

let transport: SampleTransport;
let calls: { method: string; path: string; body: unknown }[];
/** The sample workspace, with every request recorded and an optional failure for one route. */
function recording(fail?: (method: string, path: string) => ApiError | null) {
  const t = new SampleTransport();
  const real = t.request.bind(t);
  t.request = (async (method: string, path: string, body?: unknown, opts?: unknown) => {
    calls.push({ method, path, body });
    const err = fail?.(method, path);
    if (err) throw err;
    return (real as (...a: unknown[]) => Promise<unknown>)(method, path, body, opts);
  }) as typeof t.request;
  return t;
}
function client() { return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); }
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client()}><SessionProvider initialMode="sample" transportOverride={transport}>{children}</SessionProvider></QueryClientProvider>
);
async function wrap(ui: ReactNode) { return render(wrapper({ children: ui })); }
beforeEach(() => { calls = []; transport = recording(); resetPrefsForTests(); resetWebLink(); });

describe("P55 saved replies use /api/mail/snippets", () => {
  it("lists and fills in a saved reply on the server's path", async () => {
    const { result } = await renderHook(() => ({ list: useSnippets(true), render: useRenderSnippet() }), { wrapper });
    await waitFor(() => expect(result.current.list.data?.length).toBe(3), { timeout: 10000 });
    expect(calls.some((c) => c.method === "GET" && c.path === "/mail/snippets")).toBe(true);
    expect(calls.some((c) => c.path.startsWith("/mail-snippets"))).toBe(false);
    let out: { body: string } | undefined;
    await act(async () => { out = await result.current.render.mutateAsync({ id: "snp_1", to: "sam@example.com" }); });
    expect(calls.some((c) => c.method === "POST" && c.path === "/mail/snippets/snp_1/render")).toBe(true);
    expect(out?.body).toContain("Sam");
    expect(out?.body).not.toContain("{first_name}");
  });
  it("the sample workspace no longer answers the old path", async () => {
    await expect(new SampleTransport().request("GET", "/mail-snippets")).rejects.toBeTruthy();
  });
});

describe("P56 send later sends an instant from the phone's own zone", () => {
  it("localWhen answers { at } for the typed local moment, and refuses past or bad times", () => {
    const r = localWhen("2099-03-04", "9:05");
    expect(r).toEqual({ at: localMoment("2099-03-04", "09:05")!.toISOString() });
    expect(r).not.toHaveProperty("local");
    expect(localWhen("2020-01-01", "09:00")).toHaveProperty("error");
    expect(localWhen("2099-02-30", "09:00")).toHaveProperty("error");
  });
  it("the request body carries at, not local; presets still go as presets", async () => {
    const { result } = await renderHook(() => useSendLater(), { wrapper });
    const message = { mailboxId: "mbx_hello", to: ["sam@example.com"], subject: "Hi", text: "Hello" };
    const at = new Date(2099, 2, 4, 9, 5).toISOString();
    await act(async () => { await result.current.mutateAsync({ message: message as never, when: { at }, key: "k1" }); });
    await act(async () => { await result.current.mutateAsync({ message: message as never, when: { preset: "tomorrow" }, key: "k2" }); });
    const sent = calls.filter((c) => c.path === "/mail-schedules/send").map((c) => c.body as Record<string, unknown>);
    expect(sent[0]).toEqual(expect.objectContaining({ at }));
    expect(sent[0]).not.toHaveProperty("local");
    expect(sent[1]).toEqual(expect.objectContaining({ preset: "tomorrow" }));
  });
  it("the sheet's typed day and time schedule as that instant", async () => {
    const { SendLaterSheet } = require("@/components/compose-extras");
    const onSchedule = jest.fn(async () => {});
    await wrap(<SendLaterSheet visible onClose={() => {}} onSchedule={onSchedule} busy={false} blocked={null} />);
    await act(async () => { fireEvent.changeText(screen.getByTestId("later-day"), "2099-03-04"); fireEvent.changeText(screen.getByTestId("later-time"), "09:05"); });
    await act(async () => { fireEvent.press(screen.getByTestId("later-custom")); });
    expect(onSchedule).toHaveBeenCalledWith({ at: new Date(2099, 2, 4, 9, 5).toISOString() });
  });
});

describe("P57 a mailbox or tab switch ends the selection", () => {
  const Inbox = () => require("@/app/(tabs)/inbox").default;
  /** The chip of a person's mailbox (named by the part before the @). */
  async function mailboxChip() {
    const o = await new SampleTransport().request<{ mailboxes: { kind?: string; address: string }[] }>("GET", "/mail/overview");
    const people = o.mailboxes.filter((m) => m.kind !== "agent");
    expect(people.length).toBeGreaterThan(1);
    return screen.getByLabelText(new RegExp(`^${people[1].address.split("@")[0]}( |$)`));
  }
  async function selectOne() {
    const I = Inbox();
    await wrap(<I />);
    await waitFor(() => expect(screen.getByTestId("inbox-select")).toBeTruthy(), { timeout: 10000 });
    await act(async () => { fireEvent.press(screen.getByTestId("inbox-select")); });
    const first = await waitFor(() => { const all = screen.getAllByTestId(/^select-msg/); expect(all.length).toBeGreaterThan(0); return all[0]; }, { timeout: 10000 });
    await act(async () => { fireEvent.press(first); });
    await waitFor(() => expect(screen.getByText(tr("m.bulk.n_selected", { count: 1 }))).toBeTruthy());
    expect(screen.getByTestId("bulk-bar")).toBeTruthy();
  }
  it("tapping another mailbox chip ends select mode, so Delete cannot act on hidden mail", async () => {
    await selectOne();
    await act(async () => { fireEvent.press(await mailboxChip()); });
    await waitFor(() => expect(screen.queryByTestId("bulk-bar")).toBeNull());
    expect(screen.queryByTestId("select-head")).toBeNull();
    expect(calls.some((c) => c.path === "/mail/messages/bulk")).toBe(false);
    // Selecting again in the new mailbox still works.
    await act(async () => { fireEvent.press(screen.getByTestId("inbox-select")); });
    expect(await screen.findByTestId("select-head")).toBeTruthy();
    expect(screen.getByText(tr("m.bulk.n_selected", { count: 0 }))).toBeTruthy();
  });
  it("All mailboxes ends it too", async () => {
    await selectOne();
    await act(async () => { fireEvent.press(await mailboxChip()); });
    await act(async () => { fireEvent.press(screen.getByTestId("inbox-select")); });
    await act(async () => { fireEvent.press(screen.getByLabelText(tr("m.inbox.all_mailboxes"))); });
    await waitFor(() => expect(screen.queryByTestId("bulk-bar")).toBeNull());
  });
  it("switching tab ends it", async () => {
    await selectOne();
    const tab = await waitFor(() => screen.getByTestId("inbox-tab-updates"), { timeout: 10000 });
    await act(async () => { fireEvent.press(tab); });
    await waitFor(() => expect(screen.queryByTestId("bulk-bar")).toBeNull());
  });
});

describe("P67 phone details", () => {
  it("Select all counts as all at the 500 cap", () => {
    expect(allPickedOf(BULK_MAX, 600)).toBe(true);
    expect(allPickedOf(499, 600)).toBe(false);
    expect(allPickedOf(3, 3)).toBe(true);
    expect(allPickedOf(2, 3)).toBe(false);
    expect(allPickedOf(0, 0)).toBe(false);
  });

  it("the bulk bar says nothing changed when the server answers updated 0, and keeps the selection", async () => {
    transport = recording();
    const real = transport.request.bind(transport);
    transport.request = (async (method: string, path: string, body?: unknown, o?: unknown) => (path === "/mail/messages/bulk" ? { updated: 0 } : (real as (...a: unknown[]) => Promise<unknown>)(method, path, body, o))) as typeof transport.request;
    const { BulkBar } = require("@/components/mail-bulk");
    const onDone = jest.fn();
    await wrap(<BulkBar ids={["msg_1", "msg_2"]} mailbox={undefined} onDone={onDone} />);
    await act(async () => { fireEvent.press(screen.getByTestId("bulk-trash")); });
    expect(await screen.findByText(tr("m.bulk.nothing_changed"))).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });
  it("the bulk bar still finishes when the server changed the mail", async () => {
    const { BulkBar } = require("@/components/mail-bulk");
    const onDone = jest.fn();
    const sample = new SampleTransport();
    const ids = (await sample.request<{ messages: { id: string }[] }>("GET", "/mail/messages?folder=inbox")).messages.slice(0, 2).map((m) => m.id);
    await wrap(<BulkBar ids={ids} mailbox={undefined} onDone={onDone} />);
    await act(async () => { fireEvent.press(screen.getByTestId("bulk-read")); });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(screen.queryByText(tr("m.bulk.nothing_changed"))).toBeNull();
  });

  it("in select mode a row is a checkbox with its state, not 'opens the conversation'", async () => {
    const { MessageRow } = require("@/components/message-row");
    const m = { id: "msg_x", threadId: "thr_x", from: { name: "Sam", address: "sam@example.com" }, to: [], subject: "Hello", snippet: "Hi", date: new Date().toISOString(), isRead: true, isStarred: false, hasAttachments: false, labels: [] };
    const r = await render(<MessageRow m={m} onPress={() => {}} checked />);
    const row = r.getByLabelText(/^Sam/);
    expect(row.props.accessibilityRole).toBe("checkbox");
    expect(row.props.accessibilityState).toEqual({ checked: true });
    expect(row.props.accessibilityHint).toBeUndefined();
    await r.rerender(<MessageRow m={m} onPress={() => {}} checked={false} />);
    expect(r.getByLabelText(/^Sam/).props.accessibilityState).toEqual({ checked: false });
    // Outside select mode it still opens the conversation.
    await r.rerender(<MessageRow m={m} onPress={() => {}} />);
    expect(r.getByLabelText(/^Sam/).props.accessibilityRole).toBe("button");
    expect(r.getByLabelText(/^Sam/).props.accessibilityHint).toBe(tr("m.inbox.opens_the_conversation"));
  });

  it("Calendar Add shows the new task due today at once", async () => {
    const Calendar = require("@/app/calendar").default;
    await wrap(<Calendar />);
    await waitFor(() => expect(screen.getByTestId("calendar-day")).toBeTruthy(), { timeout: 10000 });
    const before = calls.filter((c) => c.path.startsWith("/calendar/events")).length;
    await act(async () => { fireEvent.press(screen.getByTestId("calendar-add")); });
    await act(async () => { fireEvent.press(screen.getByLabelText(tr("m.cal.task_due"))); });
    await act(async () => { fireEvent.changeText(screen.getByTestId("calendar-add-title"), "Ring the bank about fees"); });
    await act(async () => { fireEvent.press(screen.getByTestId("calendar-add-save")); });
    await waitFor(() => expect(calls.filter((c) => c.path.startsWith("/calendar/events")).length).toBeGreaterThan(before), { timeout: 10000 });
  });

  it("Agenda starts from today after the month was stepped back", async () => {
    const Calendar = require("@/app/calendar").default;
    await wrap(<Calendar />);
    await waitFor(() => expect(screen.getByTestId("calendar-prev")).toBeTruthy(), { timeout: 10000 });
    await act(async () => { fireEvent.press(screen.getByTestId("calendar-prev")); });
    await act(async () => { fireEvent.press(screen.getByLabelText(tr("m.cal.view_agenda"))); });
    expect(await screen.findByTestId("calendar-agenda", {}, { timeout: 10000 })).toBeTruthy();
    const from = encodeURIComponent(startOfDay(new Date()).toISOString());
    await waitFor(() => expect(calls.filter((c) => c.path.startsWith("/calendar/events")).at(-1)?.path).toContain(`from=${from}`), { timeout: 10000 });
  });

  it("Calendar settings says so when switching a calendar fails, and works when it does not", async () => {
    transport = recording((method, path) => (method === "PATCH" && path === "/calendar/sources/cal_family" ? new ApiError(403, "forbidden", "You can't change this calendar.") : null));
    const S = require("@/app/calendar-settings").default;
    await wrap(<S />);
    const sw = await screen.findByTestId("source-cal_family-switch", {}, { timeout: 10000 });
    await act(async () => { fireEvent(sw, "valueChange", false); });
    expect(await screen.findByText("You can't change this calendar.")).toBeTruthy();
  });
  it("Calendar settings switches a calendar without an error when the server agrees", async () => {
    const S = require("@/app/calendar-settings").default;
    await wrap(<S />);
    const ok = await screen.findByTestId("source-cal_family-switch", {}, { timeout: 10000 });
    await act(async () => { fireEvent(ok, "valueChange", false); });
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.path === "/calendar/sources/cal_family")).toBe(true));
    expect(screen.queryByText("You can't change this calendar.")).toBeNull();
  });

  it("a team note delete that fails shows the error", async () => {
    transport = recording((method, path) => (method === "DELETE" && path.startsWith("/threads/thr_1/comments/") ? new ApiError(403, "forbidden", "Only the writer can delete this note.") : null));
    const { ThreadTeam } = require("@/components/thread-team");
    await wrap(<ThreadTeam threadId="thr_1" />);
    const del = await screen.findByTestId("comment-delete-cmt_1", {}, { timeout: 10000 });
    await act(async () => { fireEvent.press(del); });
    expect(await screen.findByText("Only the writer can delete this note.")).toBeTruthy();
  });
});

describe("P35 the missing sign in link is remembered for 10 minutes only", () => {
  const base = "https://example.test";
  it("retries after 10 minutes", async () => {
    const request = jest.fn(async () => { throw new ApiError(404, "not_found", "Not found"); });
    const t = { request } as unknown as Pick<Transport, "request">;
    const now = jest.spyOn(Date, "now");
    try {
      now.mockReturnValue(1_000_000);
      expect(await signedInUrl(t, "/app/docs", base)).toBe(`${base}/app/docs`);
      expect(await signedInUrl(t, "/app/docs", base)).toBe(`${base}/app/docs`);
      expect(request).toHaveBeenCalledTimes(1);
      now.mockReturnValue(1_000_000 + LINK_MISSING_MS + 1);
      request.mockImplementationOnce(async () => ({ code: "C".repeat(32) }) as never);
      expect(await signedInUrl(t, "/app/docs", base)).toBe(`${base}/auth/mobile/web?code=${"C".repeat(32)}&next=%2Fapp%2Fdocs`);
      expect(request).toHaveBeenCalledTimes(2);
    } finally { now.mockRestore(); }
  });
  it("is forgotten on sign out", async () => {
    const request = jest.fn(async () => { throw new ApiError(405, "method_not_allowed", "No"); });
    const t = { request } as unknown as Pick<Transport, "request">;
    const { result } = await renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("signedIn"), { timeout: 10000 });
    await signedInUrl(t, "/app/docs", base);
    await signedInUrl(t, "/app/docs", base);
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { await result.current.signOut(); });
    expect(result.current.status).toBe("signedOut");
    await signedInUrl(t, "/app/docs", base);
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("P33 pages that open in the phone's browser are an explicit list of real routes", () => {
  it.each([
    ["/app/meetings", true], ["/app/meetings/mtg_1", true], ["/app/meetings/mtg_1/webinar", true], ["/app/files", true], ["/app/files/edit/f1", true],
    ["/app/tools/convert", true], ["/app/tools/edit-pdf", true], ["/app/tools/pdf-fix?x=1", true], ["/app/settings/mail-archive", true], ["/app/settings/data-requests", true],
    ["/app/go/downloads", false], ["/app/docs/d1/export", false], ["/app/tools/links/recordings", false], ["/app/filesx", false], ["/app/meetingsx", false],
    ["/app/tools/compare", false], ["/app/settings/account", false], ["/app/mail?q=/export", false], ["/app", false],
  ])("%s -> %s", (path, out) => { expect(opensInSystemBrowser(path as string)).toBe(out); });
});
