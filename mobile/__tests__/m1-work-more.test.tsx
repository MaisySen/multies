/**
 * M1 (1.10.9): Mail merge status, Mail archive and Calendar and contacts sync on the phone. Mock only: every request
 * goes to the sample transport (an admin), or a wrapping transport that answers as a member or with an error.
 */
import { cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Alert } from "react-native";
import { SessionProvider } from "@/lib/session";
import { SampleTransport } from "@/sample/transport";
import type { Transport } from "@/api/transport";
import { ApiError } from "@/api/errors";
import { journeyActions, listLine, newsletterActions, newsletterLine, pct, statusOf, type NewsletterView } from "@/lib/mail-merge";
import { archiveQuery, keepLine } from "@/lib/mail-archive";
import { guideSteps, hostOf, passwordName } from "@/lib/dav-sync";
import { flagOn, toolFeatureOn } from "@/lib/web-config";
import MailMerge from "@/app/mail-merge";
import NewsletterScreen from "@/app/newsletter/[id]";
import JourneyScreen from "@/app/journey/[id]";
import MailArchive from "@/app/mail-archive";
import Sync from "@/app/sync";

let mockParams: Record<string, string> = {};
const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  router: { push: (...a: unknown[]) => mockPush(...a), back: jest.fn(), replace: jest.fn(), navigate: jest.fn() },
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (cb: () => void) => { require("react").useEffect(cb, [cb]); },
  Stack: { Screen: () => null },
}));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }), SafeAreaView: ({ children }: { children: ReactNode }) => children }));
const mockCopy = jest.fn(async (_v: string) => true);
jest.mock("expo-clipboard", () => ({ setStringAsync: (v: string) => mockCopy(v) }));
const mockOpenWeb = jest.fn(async (_u: string) => ({ type: "dismiss" }));
jest.mock("expo-web-browser", () => ({ openBrowserAsync: (u: string) => mockOpenWeb(u) }));

configure({ asyncUtilTimeout: 30_000 });
jest.setTimeout(180_000);

/** Alert.alert presses the first button that is not Cancel, as if the person confirmed. */
const alertSpy = jest.spyOn(Alert, "alert").mockImplementation((_t, _m, buttons) => {
  const ok = buttons?.find((b) => b.style !== "cancel");
  ok?.onPress?.();
});

async function wrap(ui: ReactNode, transport: Transport = new SampleTransport()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return await render(<QueryClientProvider client={qc}><SessionProvider initialMode="sample" transportOverride={transport}>{ui}</SessionProvider></QueryClientProvider>);
}

type Hook = (m: Parameters<Transport["request"]>[0], p: string, b: unknown, s: SampleTransport) => Promise<unknown> | undefined;
/** A sample transport with one hook in front: return a value (or throw) to answer, undefined to pass through. */
function wrapped(hook: Hook): Transport & { calls: string[] } {
  const s = new SampleTransport();
  const calls: string[] = [];
  return {
    kind: "sample", calls,
    request: async <T,>(m: Parameters<Transport["request"]>[0], p: string, b?: unknown) => {
      calls.push(`${m} ${p}`);
      const r = hook(m, p, b, s);
      if (r !== undefined) return (await r) as T;
      return s.request<T>(m, p, b);
    },
  };
}
const err = (status: number) => Promise.reject(new ApiError(status, status === 403 ? "forbidden" : "not_found", status === 403 ? "You don't have access to that." : "Not found."));
/** A member: the server says canSend false and canManage false; admin only archive routes answer 403. */
const member = () => wrapped((m, p, b, s) => {
  if (p === "/mail-archive/holds" || p === "/mail-archive/cases" || p === "/mail-archive/search") return err(403);
  if (p === "/mail-archive/policy") return s.request<{ policy: Record<string, unknown> }>(m, p, b).then((r) => ({ policy: { ...r.policy, canManage: false, activeHolds: undefined } }));
  if (m === "GET" && /^\/tools\/campaigns\/(newsletters|journeys)\/[^/]+$/.test(p)) return s.request<Record<string, unknown>>(m, p, b).then((r) => ({ ...r, canSend: false }));
  return undefined;
});

beforeEach(() => { mockPush.mockClear(); mockParams = {}; alertSpy.mockClear(); mockCopy.mockClear(); mockOpenWeb.mockClear(); });
afterEach(async () => { await cleanup(); });

describe("helpers", () => {
  const base: NewsletterView = { id: "n", name: "N", subject: "", status: "sending", listId: "l", listName: "Customers", mailboxId: "m", scheduledAt: null, sentAt: null, error: null,
    stats: { total: 400, sent: 100, failed: 0, skipped: 0, opened: 25, clicked: 5, unsubscribed: 0, bounced: 0 }, updatedAt: "2026-11-01T00:00:00Z", canSend: true };
  it("allows pause only while sending and resume only when paused, for people who may send", () => {
    expect(newsletterActions(base)).toEqual({ pause: true, resume: false, test: true });
    expect(newsletterActions({ ...base, status: "paused" })).toEqual({ pause: false, resume: true, test: true });
    expect(newsletterActions({ ...base, canSend: false })).toEqual({ pause: false, resume: false, test: true });
    expect(newsletterActions({ ...base, mailboxId: null, status: "sent" })).toEqual({ pause: false, resume: false, test: false });
    expect(journeyActions({ status: "active", canSend: true })).toEqual({ pause: true, start: false });
    expect(journeyActions({ status: "paused", canSend: true })).toEqual({ pause: false, start: true });
    expect(journeyActions({ status: "draft", canSend: false })).toEqual({ pause: false, start: false });
  });
  it("writes plain lines and labels", () => {
    expect(newsletterLine(base)).toBe("100 of 400 sent");
    expect(statusOf("cancelled").label).toBe("Stopped");
    expect(pct(25, 100)).toBe(25);
    expect(pct(3, 0)).toBe(0);
    expect(listLine({ id: "l", name: "L", visibility: "workspace", mine: true, canSend: true, subscribed: 1200, pending: 3, unsubscribed: 0, bounced: 0, updatedAt: "" })).toBe("1,200 subscribed, 3 waiting to confirm");
    expect(keepLine({ enabled: false, keepYears: null, startsAt: null, lastRunAt: null, lastRunDeleted: 0, totalDeleted: 0, timeZone: "UTC", canManage: false })).toBe("Kept until someone deletes it");
    expect(keepLine({ enabled: true, keepYears: 7, startsAt: null, lastRunAt: null, lastRunDeleted: 0, totalDeleted: 0, timeZone: "UTC", canManage: false })).toBe("7 years, then deleted");
  });
  it("keeps archive words and app password names within the server's limits, never cutting a character", () => {
    expect(archiveQuery("  invoice   4471 ")).toBe("invoice 4471");
    const long = "नेपाली".repeat(80);
    expect(Array.from(archiveQuery(long)).length).toBe(200);
    expect(passwordName("   ")).toBe("My phone");
    expect(Array.from(passwordName("🙂".repeat(70))).length).toBe(60);
    expect(hostOf("https://multies.si/dav/")).toBe("multies.si");
    expect(guideSteps("iphone", "https://multies.si/dav/")[1]).toContain("multies.si");
    expect(guideSteps("android", "https://multies.si/dav/")).toHaveLength(2);
  });
  it("reads flags as the web does", () => {
    expect(flagOn({ davSync: true }, "davSync")).toBe(true);
    expect(flagOn({ davSync: "yes" } as never, "davSync")).toBe(false);
    expect(toolFeatureOn({ tools: true, toolFeatures: ["merge_plus_r109"] }, "merge_plus_r109")).toBe(true);
    expect(toolFeatureOn({ tools: false, toolFeatures: ["merge_plus_r109"] }, "merge_plus_r109")).toBe(false);
    expect(toolFeatureOn({ tools: true, toolFeatures: ["merge_mail"] }, "merge_plus_r109")).toBe(false);
  });
});

describe("Mail merge", () => {
  it("lists newsletters with status, then lists and journeys, and opens a newsletter", async () => {
    await wrap(<MailMerge />);
    expect(await screen.findByText("November specials")).toBeTruthy();
    expect(screen.getByText("180 of 420 sent")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("newsletter-nl_s1"));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/newsletter/[id]", params: { id: "nl_s1" } });
    await fireEvent.press(screen.getByText("Lists"));
    expect(await screen.findByText("420 subscribed, 6 waiting to confirm, 11 unsubscribed")).toBeTruthy();
    await fireEvent.press(screen.getByText("Journeys"));
    expect(await screen.findByText("Welcome series")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("merge-web"));
    expect(mockOpenWeb.mock.calls[0]![0]).toMatch(/\/app\/tools\/merge$/);
  });
  it("says so when mail merge is off on the server", async () => {
    await wrap(<MailMerge />, wrapped((m, p) => (p.startsWith("/tools/campaigns") ? err(404) : undefined)));
    expect(await screen.findByText("Mail merge is off")).toBeTruthy();
  });
  it("hides itself when the Tools feature is not on in the web config", async () => {
    await wrap(<MailMerge />, wrapped((m, p) => (p === "/config" ? Promise.resolve({ tools: true, toolFeatures: [] }) : undefined)));
    expect(await screen.findByText("Mail merge is off")).toBeTruthy();
  });
  it("pauses and resumes a sending newsletter after a confirm, and sends a test", async () => {
    mockParams = { id: "nl_s1" };
    const t = wrapped(() => undefined);
    await wrap(<NewsletterScreen />, t);
    expect(await screen.findByTestId("newsletter-name")).toBeTruthy();
    expect(screen.queryByTestId("newsletter-resume")).toBeNull();
    await fireEvent.press(screen.getByTestId("newsletter-pause"));
    expect(alertSpy.mock.calls[0]![0]).toBe("Pause this newsletter?");
    expect(await screen.findByTestId("newsletter-resume")).toBeTruthy();
    expect(t.calls).toContain("POST /tools/campaigns/newsletters/nl_s1/pause");
    await fireEvent.press(screen.getByTestId("newsletter-resume"));
    expect(await screen.findByTestId("newsletter-pause")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("newsletter-test"));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("Test sent", "A test copy went to you@harbourbuild.com.au."));
  });
  it("a member sees counts but no Pause, with the plain reason", async () => {
    mockParams = { id: "nl_s1" };
    await wrap(<NewsletterScreen />, member());
    expect(await screen.findByTestId("newsletter-no-send")).toBeTruthy();
    expect(screen.queryByTestId("newsletter-pause")).toBeNull();
    expect(screen.getByTestId("newsletter-stats")).toBeTruthy();
  });
  it("pauses an active journey and starts a paused one", async () => {
    mockParams = { id: "jr_s1" };
    const first = await wrap(<JourneyScreen />);
    expect(await screen.findByTestId("journey-pause")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("journey-pause"));
    expect(await screen.findByTestId("journey-start")).toBeTruthy();
    await first.unmount();
  });
  it("a member cannot start or pause a journey", async () => {
    mockParams = { id: "jr_s2" };
    await wrap(<JourneyScreen />, member());
    expect(await screen.findByTestId("journey-no-send")).toBeTruthy();
    expect(screen.queryByTestId("journey-start")).toBeNull();
  });
});

describe("Mail archive", () => {
  it("an admin sees the policy, active holds, saved cases and read only search results", async () => {
    await wrap(<MailArchive />);
    expect(await screen.findByText("7 years, then deleted")).toBeTruthy();
    expect(await screen.findByTestId("hold-hold_s1")).toBeTruthy();
    expect(screen.queryByTestId("hold-hold_s2")).toBeNull();
    expect(await screen.findByTestId("case-case_s1")).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId("archive-search"), "invoice 4471");
    await fireEvent.press(screen.getByTestId("archive-search-go"));
    expect(await screen.findByTestId("hit-am_s1")).toBeTruthy();
    expect(screen.queryByTestId("hit-am_s2")).toBeNull();
    expect(screen.getByText("On hold")).toBeTruthy();
  });
  it("a member sees only the read only policy and the plain note", async () => {
    const t = member();
    await wrap(<MailArchive />, t);
    expect(await screen.findByTestId("archive-member-note")).toBeTruthy();
    expect(screen.queryByTestId("archive-search")).toBeNull();
    expect(t.calls.some((c) => c.includes("/mail-archive/holds"))).toBe(false);
  });
  it("says so when the archive is off", async () => {
    await wrap(<MailArchive />, wrapped((m, p) => (p.startsWith("/mail-archive") ? err(404) : undefined)));
    expect(await screen.findByText("Mail archive is off")).toBeTruthy();
  });
});

describe("Calendar and contacts sync", () => {
  it("shows the server and user name with Copy, makes a password shown once, and revokes one", async () => {
    await wrap(<Sync />);
    expect(await screen.findByText("https://preview.multies.si/dav/")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("sync-server"));
    expect(mockCopy).toHaveBeenCalledWith("https://preview.multies.si/dav/");
    await fireEvent.changeText(screen.getByTestId("sync-name"), "Pixel");
    await fireEvent.press(screen.getByTestId("sync-make"));
    expect(await screen.findByTestId("sync-made-password")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("sync-copy"));
    expect(mockCopy).toHaveBeenLastCalledWith("abcd efgh ijkl mnop");
    expect(await screen.findByText("Pixel")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("sync-done"));
    expect(screen.queryByTestId("sync-made-password")).toBeNull();
    await fireEvent.press(screen.getByTestId("sync-revoke-dav_s1"));
    await waitFor(() => expect(screen.queryByTestId("sync-pw-dav_s1")).toBeNull());
    expect(screen.getByTestId("sync-steps")).toBeTruthy();
  });
  it("says so when sync is off", async () => {
    await wrap(<Sync />, wrapped((m, p) => (p === "/config" ? Promise.resolve({ davSync: false }) : undefined)));
    expect(await screen.findByText("Sync is off")).toBeTruthy();
  });
});
