/**
 * M3 (1.10.11): Goals, Forms, Time and Automations are app screens now; More lists app screens first and web only
 * pages in their own group; every web page opens inside the app (Done, app colours, Android in the app's task).
 * Mock only: the sample transport, or a wrapping transport that answers with errors.
 */
import { cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SessionProvider } from "@/lib/session";
import { SampleTransport } from "@/sample/transport";
import type { Transport } from "@/api/transport";
import { ApiError } from "@/api/errors";
import { nativeRoute } from "@/lib/nav-menu";
import { appPathOf, inAppOptions, openAppPath, openInApp, openWeb, registerWebTransport, resetWebLink } from "@/lib/web-open";
import { automationLine, entriesByDay, flattenGoals, krLine, pct, responsePreview, weekStart, type Goal } from "@/lib/m3";
import { sampleM3 } from "@/sample/m3";
import Goals from "@/app/goals";
import Forms, { formSub } from "@/app/forms";
import FormResponsesScreen from "@/app/form/[id]";
import Time from "@/app/time";
import Automations from "@/app/automations";
import MoreSection from "@/app/more/[section]";
import { setKV, memoryKV } from "@/lib/kv";

let mockParams: Record<string, string> = {};
const mockPush = jest.fn();
const mockBack = jest.fn();
const mockReplace = jest.fn();
let mockCanGoBack = true;
jest.mock("expo-router", () => ({
  router: { push: (...a: unknown[]) => mockPush(...a), back: () => mockBack(), replace: (...a: unknown[]) => mockReplace(...a), navigate: jest.fn(), canGoBack: () => mockCanGoBack },
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (cb: () => void) => { require("react").useEffect(cb, [cb]); },
  Stack: { Screen: () => null },
}));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }), SafeAreaView: ({ children }: { children: ReactNode }) => children }));
const mockOpen = jest.fn(async (_u: string, _o?: unknown) => ({ type: "dismiss" }));
jest.mock("expo-web-browser", () => ({ openBrowserAsync: (u: string, o?: unknown) => mockOpen(u, o) }));

configure({ asyncUtilTimeout: 10_000 });
jest.setTimeout(120_000);

async function wrap(ui: ReactNode, transport: Transport = new SampleTransport()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return await render(<QueryClientProvider client={qc}><SessionProvider initialMode="sample" transportOverride={transport}>{ui}</SessionProvider></QueryClientProvider>);
}
function failing(status: number, match: RegExp): Transport {
  class Failing extends SampleTransport {
    async request<T>(m: Parameters<SampleTransport["request"]>[0], p: string, b?: unknown): Promise<T> {
      if (match.test(p)) throw new ApiError(status, "nope", "No");
      return super.request<T>(m, p, b);
    }
  }
  return new Failing();
}

beforeEach(() => { mockCanGoBack = true; mockBack.mockClear(); mockReplace.mockClear(); mockPush.mockClear(); mockOpen.mockClear(); mockParams = {}; setKV(memoryKV()); resetWebLink(); registerWebTransport(null); });
afterEach(cleanup);

describe("pure rules", () => {
  const now = new Date("2026-11-04T10:00:00").getTime();
  const s = sampleM3(now);
  test("goals flatten parents first with depth", () => {
    const rows = flattenGoals(s.goals.goals);
    expect(rows.map((r) => [r.goal.id, r.depth])).toEqual([["gl_1", 0], ["gl_2", 1], ["gl_3", 0]]);
    const loop: Goal = { ...s.goals.goals[2], children: [] }; loop.children = [loop];
    expect(flattenGoals([loop]).length).toBe(5); // depth capped, never endless
  });
  test("key result lines", () => {
    const [k1, k2] = s.goals.goals[0].keyResults;
    expect(krLine(k1)).toBe("8 of 12 clients");
    expect(krLine(k2)).toBe("$32,200 of $40,000");
    expect(krLine(s.goals.goals[0].children[0].keyResults[0])).toBe("2 of 5 tasks");
    expect(krLine(s.goals.goals[1].keyResults[0])).toBe("89% of 95%");
    expect(pct(140)).toBe(100); expect(pct(-3)).toBe(0); expect(pct(Number.NaN)).toBe(0);
  });
  test("response preview skips empty answers and keeps labels", () => {
    const r = { id: "x", createdAt: "", answers: { f1: "", f2: "a@b.co", f3: "Line one\n\nline two" } };
    expect(responsePreview(r, s.responses.fields)).toEqual([{ label: "Email", value: "a@b.co" }, { label: "What do you need help with?", value: "Line one line two" }]);
  });
  test("time groups by day, newest first, with totals", () => {
    const days = entriesByDay(s.time.entries, now);
    expect(days[0].title).toBe("Today");
    expect(days[1].title).toBe("Yesterday");
    expect(days[0].seconds).toBe(2100 + 5400);
    expect(new Date(weekStart(now)).getDay()).toBe(1);
  });
  test("automation lines in plain words", () => {
    expect(automationLine({ trigger: "email_received", action: "create_task" })).toBe("When an email arrives, make a task");
    expect(automationLine({ trigger: "something_new", action: "do_this" })).toBe("Something new, do this");
  });
  test("form subtitle", () => {
    expect(formSub({ enabled: false, submitCount: 1, lastSubmitAt: null })).toBe("Closed · 1 response");
    expect(formSub({ enabled: true, submitCount: 0, lastSubmitAt: null })).toBe("0 responses");
  });
});

describe("where pages open", () => {
  test("web pages the app now covers open app screens", () => {
    expect(nativeRoute("/app/goals")).toBe("/goals");
    expect(nativeRoute("/app/forms")).toBe("/forms");
    expect(nativeRoute("/app/time")).toBe("/time");
    expect(nativeRoute("/app/automations")).toBe("/automations");
    expect(nativeRoute("/app/triage")).toBe("/notifications");
    expect(nativeRoute("/app/activity")).toBe("/notifications");
    expect(nativeRoute("/app/approvals")).toBe("/review"); // a stack screen: hidden tab routes do not open on Android
    expect(nativeRoute("/app/social/inbox")).toBe("/social?tab=inbox");
    expect(nativeRoute("/app/settings/mail")).toBe("/mail-settings");
    expect(nativeRoute("/app/dashboards")).toBeNull();
  });
  test("appPathOf only accepts this server's /app pages", () => {
    expect(appPathOf("https://multies.si/app/goals?x=1", "https://multies.si")).toBe("/app/goals?x=1");
    expect(appPathOf("/app/docs", "https://multies.si")).toBe("/app/docs");
    expect(appPathOf("https://evil.example/app/x", "https://multies.si")).toBeNull();
    expect(appPathOf("/app//evil.example", "https://multies.si")).toBeNull();
    expect(appPathOf("/privacy", "https://multies.si")).toBeNull();
  });
  test("in app browser options: Done, app colours, Android stays in the app task", () => {
    const o = inAppOptions();
    expect(o).toMatchObject({ dismissButtonStyle: "done", createTask: false, showTitle: true });
    expect(typeof o.toolbarColor).toBe("string");
  });
  test("openInApp refuses anything but https", async () => {
    await openInApp("javascript:alert(1)"); await openInApp("http://x.example");
    expect(mockOpen).not.toHaveBeenCalled();
    await openInApp("https://multies.si/privacy");
    expect(mockOpen).toHaveBeenCalledWith("https://multies.si/privacy", expect.objectContaining({ createTask: false }));
  });
  test("openWeb signs in for web app pages when a live session is registered", async () => {
    const request = jest.fn(async () => ({ code: "c".repeat(32) }));
    registerWebTransport({ request } as never);
    await openWeb("/app/dashboards");
    expect(request).toHaveBeenCalledWith("POST", "/auth/mobile/web-link", { next: "/app/dashboards" });
    expect(String(mockOpen.mock.calls[0][0])).toMatch(/\/auth\/mobile\/web\?code=c{32}&next=%2Fapp%2Fdashboards$/);
  });
  test("openAppPath prefers the app screen", async () => {
    await openAppPath("/app/goals");
    expect(mockPush).toHaveBeenCalledWith("/goals");
    expect(mockOpen).not.toHaveBeenCalled();
  });
});

describe("screens", () => {
  test("Goals shows progress, health and key results", async () => {
    await wrap(<Goals />);
    expect(await screen.findByTestId("goals-screen")).toBeTruthy();
    expect(screen.getByText("Grow monthly revenue to $40k")).toBeTruthy();
    expect(screen.getByText("At risk")).toBeTruthy();
    expect(screen.getByText("8 of 12 clients")).toBeTruthy();
  });
  test("a pushed screen has a back button", async () => {
    await wrap(<Goals />);
    await screen.findByTestId("goals-screen");
    fireEvent.press(screen.getByTestId("screen-back"));
    expect(mockBack).toHaveBeenCalled();
  });
  test("a screen opened straight from a link offers Today", async () => {
    mockCanGoBack = false;
    await wrap(<Forms />);
    await screen.findByTestId("forms-screen");
    expect(screen.getByText("Today")).toBeTruthy();
    fireEvent.press(screen.getByTestId("screen-back"));
    expect(mockReplace).toHaveBeenCalledWith("/today");
  });
  test("a child goal says which goal it is part of, without indenting", async () => {
    await wrap(<Goals />);
    expect(await screen.findByText("Part of Grow monthly revenue to $40k")).toBeTruthy();
  });
  test("Goals error offers Retry", async () => {
    await wrap(<Goals />, failing(500, /^\/goals/));
    expect(await screen.findByTestId("goals-retry")).toBeTruthy();
  });
  test("Goals without access says so", async () => {
    await wrap(<Goals />, failing(403, /^\/goals/));
    expect(await screen.findByText("Goals aren't open to you")).toBeTruthy();
  });
  test("Forms lists forms and opens responses in the app", async () => {
    await wrap(<Forms />);
    fireEvent.press(await screen.findByTestId("form-fm_1"));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/form/[id]", params: { id: "fm_1", name: "Client intake", url: "https://multies.si/f/client-intake" } });
    expect(mockOpen).not.toHaveBeenCalled();
  });
  test("Form responses show answers and share", async () => {
    mockParams = { id: "fm_1", name: "Client intake", url: "https://multies.si/f/client-intake" };
    await wrap(<FormResponsesScreen />);
    expect(await screen.findByText("Priya Nair")).toBeTruthy();
    expect(screen.getByTestId("form-share")).toBeTruthy();
  });
  test("Time shows the week and entries by day", async () => {
    await wrap(<Time />);
    expect(await screen.findByTestId("time-week")).toBeTruthy();
    expect(screen.getByText("Client call notes")).toBeTruthy();
    fireEvent.press(screen.getByTestId("time-t2"));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/task/[id]", params: { id: "tsk_t2" } });
  });
  test("Automations show each rule in plain words", async () => {
    await wrap(<Automations />);
    expect(await screen.findByText(/When an email arrives, make a task · ran/)).toBeTruthy();
    expect(screen.getByText("Agent runs")).toBeTruthy();
  });
  test("More section: app screens first, web only pages in their own group, no All of row", async () => {
    mockParams = { section: "tasks" };
    await wrap(<MoreSection />);
    await screen.findByTestId("more-section-tasks");
    expect(screen.queryByTestId("more-section-web")).toBeNull();
    fireEvent.press(screen.getByTestId("more-page-/app/goals"));
    expect(mockPush).toHaveBeenCalledWith("/goals");
    fireEvent.press(screen.getByTestId("more-page-/app/time"));
    expect(mockPush).toHaveBeenCalledWith("/time");
    await waitFor(() => expect(mockOpen).not.toHaveBeenCalled());
  });
});
