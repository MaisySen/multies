/**
 * M2 (1.10.10): the More grid from the web menu, its section screens, signed in web pages, Deals and Expenses.
 * Mock only: the sample transport (an admin), or a wrapping transport that answers as an older server or with errors.
 */
import { cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setOffline } from "@/lib/offline";
import type { ReactNode } from "react";
import { SessionProvider } from "@/lib/session";
import { SampleTransport } from "@/sample/transport";
import type { Transport } from "@/api/transport";
import { ApiError } from "@/api/errors";
import { setKV, memoryKV } from "@/lib/kv";
import { cleanHidden, countOf, FALLBACK_MENU, nativeRoute, parseMenu, sectionCount, sectionExtras, withUsed, canHide } from "@/lib/nav-menu";
import { resetWebLink, safeAppPath, signedInUrl } from "@/lib/web-open";
import { byStage, money, pipeline } from "@/lib/deals";
import { canSubmit, cents, receiptUploadPath, statusOf } from "@/lib/expenses";
import { SAMPLE_NAV_MENU } from "@/sample/nav-menu";
import More from "@/app/(tabs)/more";
import MoreSection from "@/app/more/[section]";
import Deals from "@/app/deals";
import DealScreen from "@/app/deal/[id]";
import Expenses from "@/app/expenses";
import ExpenseScreen from "@/app/expense/[id]";

let mockParams: Record<string, string> = {};
const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  router: { push: (...a: unknown[]) => mockPush(...a), back: jest.fn(), replace: jest.fn(), navigate: jest.fn() },
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (cb: () => void) => { require("react").useEffect(cb, [cb]); },
  Stack: { Screen: () => null },
}));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }), SafeAreaView: ({ children }: { children: ReactNode }) => children }));
const mockOpenWeb = jest.fn(async (_u: string) => ({ type: "dismiss" }));
jest.mock("expo-web-browser", () => ({ openBrowserAsync: (u: string) => mockOpenWeb(u) }));
const mockPick = jest.fn();
jest.mock("expo-document-picker", () => ({ getDocumentAsync: (...a: unknown[]) => mockPick(...a) }));

configure({ asyncUtilTimeout: 10_000 });
jest.setTimeout(180_000);

async function wrap(ui: ReactNode, transport: Transport = new SampleTransport()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return await render(<QueryClientProvider client={qc}><SessionProvider initialMode="sample" transportOverride={transport}>{ui}</SessionProvider></QueryClientProvider>);
}
type Hook = (m: Parameters<Transport["request"]>[0], p: string, b: unknown, s: SampleTransport) => Promise<unknown> | undefined;
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
const err = (status: number) => Promise.reject(new ApiError(status, status === 403 ? "forbidden" : status === 404 ? "not_found" : "server_error", "No."));

beforeEach(() => { mockPush.mockClear(); mockParams = {}; mockOpenWeb.mockClear(); mockPick.mockReset(); setKV(memoryKV()); resetWebLink(); });
afterEach(() => { cleanup(); onlineManager.setOnline(true); setOffline(false); });

describe("menu model", () => {
  test("parses the web answer and drops anything malformed", () => {
    const m = parseMenu(SAMPLE_NAV_MENU)!;
    expect(m.sections.map((s) => s.id)).toEqual(["home", "mail", "chat", "tasks", "docs", "social", "contacts", "tools", "dashboards", "agents", "workspace"]);
    expect(m.mailSetup.map((x) => x.label)).toEqual(["Mailboxes", "Domains", "Deliverability", "Routing"]);
    expect(parseMenu(null)).toBeNull();
    expect(parseMenu({ version: 1, sections: [] })).toBeNull();
    expect(parseMenu({ version: 1, sections: [{ id: "x", label: "X", to: "https://evil.example/app", pages: [{ to: "/app/x", label: "X" }] }] })).toBeNull();
    const bad = parseMenu({ version: 1, sections: [{ id: "a", label: "A", icon: "home", to: "/app/a", pages: [{ to: "//evil", label: "E" }, { to: "/app/a", label: "A", whenUsed: "https://x" }] }] })!;
    expect(bad.sections[0].pages).toEqual([{ to: "/app/a", label: "A", icon: "" }]);
  });
  test("pages shown once used leave when not used", () => {
    const m = parseMenu(SAMPLE_NAV_MENU)!;
    expect(withUsed(m, {}).sections.find((s) => s.id === "docs")!.pages.some((p) => p.label === "Sites")).toBe(false);
    expect(withUsed(m, { "/api/sites/in-use": true }).sections.find((s) => s.id === "docs")!.pages.some((p) => p.label === "Sites")).toBe(true);
  });
  test("native screens where the app has them, else the web", () => {
    expect(nativeRoute("/app/mail")).toBe("/inbox");
    expect(nativeRoute("/app/deals")).toBe("/deals");
    expect(nativeRoute("/app/expenses")).toBe("/expenses");
    expect(nativeRoute("/app/files/")).toBe("/files");
    expect(nativeRoute("/app/tasks", { tasks: false })).toBeNull();
    expect(nativeRoute("/app/forms")).toBeNull();
  });
  test("counts follow the server's keys", () => {
    const counts = { mail: { inbox: 4 }, chat: { unread: 2, mentions: 1 }, notifications: { unread: 3 }, triage: 1, tasks: { dueToday: 0, overdue: 0 } };
    expect(countOf(counts, "mail.inbox")).toBe(4);
    expect(countOf(counts, "nope.x")).toBe(0);
    const home = parseMenu(SAMPLE_NAV_MENU)!.sections[0];
    expect(sectionCount(home, counts)).toBe(4);
    expect(sectionCount(home, null)).toBe(0);
  });
  test("Home and Settings can never be hidden", () => {
    expect(cleanHidden(["mail", "home", "workspace", "mail", 3, "tools"])).toEqual(["mail", "tools"]);
    expect(canHide("home")).toBe(false);
  });
  test("Expenses and Invoices join Contacts only when switched on", () => {
    expect(sectionExtras("contacts", { expenses: true, invoices: true }, []).map((p) => p.label)).toEqual(["Expenses", "Invoices"]);
    expect(sectionExtras("contacts", { expenses: false }, [])).toEqual([]);
    expect(sectionExtras("tools", { expenses: true }, [])).toEqual([]);
  });
  test("the fallback lists only screens the app has", () => {
    for (const s of FALLBACK_MENU.sections) for (const p of s.pages) expect(nativeRoute(p.to)).not.toBeNull();
  });
});

describe("signed in web pages", () => {
  test("mints a fresh code per tap and opens the sign in link; falls back to the plain page", async () => {
    const code = "a".repeat(43);
    const ok = { request: jest.fn(async () => ({ code, expires_in: 60 })) };
    expect(await signedInUrl(ok as never, "/app/forms", "https://multies.si")).toBe(`https://multies.si/auth/mobile/web?code=${code}&next=%2Fapp%2Fforms`);
    await signedInUrl(ok as never, "/app/forms", "https://multies.si");
    expect(ok.request).toHaveBeenCalledTimes(2);
    expect(ok.request).toHaveBeenCalledWith("POST", "/auth/mobile/web-link", expect.objectContaining({ next: expect.stringMatching(/^\/app\//) }));
    const junk = { request: jest.fn(async () => ({ code: "../x" })) };
    expect(await signedInUrl(junk as never, "/app/forms", "https://multies.si")).toBe("https://multies.si/app/forms");
    const limited = { request: jest.fn(async () => { throw new ApiError(429, "rate_limited", "Slow down"); }) };
    expect(await signedInUrl(limited as never, "/app/forms", "https://multies.si")).toBe("https://multies.si/app/forms");
    await signedInUrl(limited as never, "/app/forms", "https://multies.si");
    expect(limited.request).toHaveBeenCalledTimes(2);
    const old = { request: jest.fn(async () => { throw new ApiError(404, "not_found", "No"); }) };
    expect(await signedInUrl(old as never, "/app/forms", "https://multies.si")).toBe("https://multies.si/app/forms");
    await signedInUrl(old as never, "/app/forms", "https://multies.si");
    expect(old.request).toHaveBeenCalledTimes(1);
    expect(safeAppPath("https://evil.example")).toBe("/app");
    expect(safeAppPath("/app//evil")).toBe("/app");
  });
});

describe("More grid", () => {
  test("shows every section the server lists, with counts, and opens a section", async () => {
    await wrap(<More />);
    await screen.findByTestId("more-grid");
    for (const id of ["home", "mail", "chat", "tasks", "docs", "social", "contacts", "tools", "dashboards", "agents", "workspace"]) expect(screen.getByTestId(`more-tile-${id}`)).toBeTruthy();
    expect(screen.queryByTestId("more-note-old")).toBeNull();
    fireEvent.press(screen.getByTestId("more-tile-contacts"));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/more/[section]", params: { section: "contacts" } });
  });
  test("an older server without the menu shows what the app has, with a note", async () => {
    await wrap(<More />, wrapped((m, p) => (p === "/nav/menu" ? err(404) : undefined)));
    await screen.findByTestId("more-note-old");
    expect(screen.getByTestId("more-tile-mail")).toBeTruthy();
    expect(screen.queryByTestId("more-tile-dashboards")).toBeNull();
  });
  test("a server error shows the fallback with Retry, and Retry asks again", async () => {
    let fail = true;
    const t = wrapped((m, p) => (p === "/nav/menu" && fail ? err(500) : undefined));
    await wrap(<More />, t);
    await screen.findByTestId("more-note-error");
    fail = false;
    fireEvent.press(screen.getAllByTestId("more-retry")[0]);
    await screen.findByTestId("more-tile-dashboards");
    expect(t.calls.filter((c) => c === "GET /nav/menu").length).toBe(2);
  });
  test("offline shows the last menu saved on the phone", async () => {
    setKV(memoryKV({ "nav.menu.sample": JSON.stringify(parseMenu(SAMPLE_NAV_MENU)) }));
    await wrap(<More />, wrapped((m, p) => (p === "/nav/menu" ? Promise.reject(new ApiError(0, "offline", "Network request failed")) : undefined)));
    await screen.findByTestId("more-note-offline");
    expect(screen.getByTestId("more-tile-dashboards")).toBeTruthy();
  });
  test("offline with nothing saved shows what the app has", async () => {
    await wrap(<More />, wrapped((m, p) => (p === "/nav/menu" ? Promise.reject(new ApiError(0, "offline", "Network request failed")) : undefined)));
    await screen.findByTestId("more-note-offline");
    expect(screen.queryByTestId("more-tile-dashboards")).toBeNull();
  });
  test("hide a section and Reset shows it again; Home cannot be hidden", async () => {
    const store = memoryKV();
    setKV(store);
    await wrap(<More />);
    await screen.findByTestId("more-grid");
    fireEvent.press(screen.getByTestId("more-edit"));
    expect(await screen.findByLabelText("Home, always shown")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Hide Social"));
    await screen.findByLabelText("Show Social");
    await waitFor(async () => expect(JSON.parse((await store.get("nav.hidden.sample")) ?? "[]")).toEqual(["social"]));
    fireEvent.press(screen.getByTestId("more-edit"));
    await waitFor(() => expect(screen.queryByTestId("more-tile-social")).toBeNull());
    expect(screen.getByTestId("more-hidden-note")).toBeTruthy();
    fireEvent.press(screen.getByTestId("more-edit"));
    fireEvent.press(await screen.findByTestId("more-reset"));
    await waitFor(() => expect(screen.queryByTestId("more-reset")).toBeNull());
    fireEvent.press(screen.getByTestId("more-edit"));
    await screen.findByTestId("more-tile-social");
  });
  test("sections hidden earlier stay hidden", async () => {
    setKV(memoryKV({ "nav.hidden.sample": JSON.stringify(["social", "home"]) }));
    await wrap(<More />);
    await screen.findByTestId("more-grid");
    await waitFor(() => expect(screen.queryByTestId("more-tile-social")).toBeNull());
    expect(screen.getByTestId("more-tile-home")).toBeTruthy();
  });
});

describe("More sections", () => {
  test("native pages open their screen, the rest open the web page", async () => {
    mockParams = { section: "contacts" };
    await wrap(<MoreSection />);
    await screen.findByTestId("more-section-contacts");
    fireEvent.press(screen.getByTestId("more-page-/app/deals"));
    expect(mockPush).toHaveBeenCalledWith("/deals");
    await screen.findByTestId("more-page-/app/expenses");
    fireEvent.press(screen.getByTestId("more-page-/app/contacts/invoices"));
    await waitFor(() => expect(mockOpenWeb).toHaveBeenCalled());
    expect(mockOpenWeb.mock.calls[0][0]).toMatch(/\/app\/contacts\/invoices$/);
  });
  test("Settings lists Mail setup", async () => {
    mockParams = { section: "workspace" };
    await wrap(<MoreSection />);
    await screen.findByTestId("more-section-workspace");
    expect(screen.getByText("Mail setup")).toBeTruthy();
    expect(screen.getByTestId("more-page-/app/settings/domains")).toBeTruthy();
  });
  test("a section the person cannot see says so", async () => {
    mockParams = { section: "operator" };
    await wrap(<MoreSection />);
    await screen.findByTestId("more-section-missing");
  });
});

describe("Deals", () => {
  test("pipeline by stage, search and detail with Move", async () => {
    const r = { stages: [], deals: [{ id: "a", title: "A", stage: "lead", value: 100, currency: "AUD", probability: 10 }, { id: "b", title: "B", stage: "won", value: 50, currency: "AUD" }] } as never;
    expect(byStage(r).map((s) => s.items.length)).toEqual([1, 0, 0, 1, 0]);
    expect(pipeline(r)).toEqual({ count: 1, value: 100, forecast: 10 });
    expect(money(18500)).toMatch(/18,500/);
    await wrap(<Deals />);
    await screen.findByTestId("deals-pipeline");
    expect(screen.getByTestId("deal-del_s3")).toBeTruthy();
    fireEvent.changeText(screen.getByTestId("deals-search"), "menu");
    await waitFor(() => expect(screen.queryByTestId("deal-del_s3")).toBeNull());
    expect(screen.getByTestId("deal-del_s4")).toBeTruthy();
  });
  test("deal detail moves a stage", async () => {
    mockParams = { id: "del_s1" };
    await wrap(<DealScreen />);
    await screen.findByTestId("deal-screen");
    fireEvent.press(screen.getByTestId("deal-move"));
    fireEvent.press(await screen.findByText("Proposal"));
    await waitFor(() => expect(screen.getByLabelText("Stage, Proposal")).toBeTruthy());
  });
  test("an error shows Retry", async () => {
    await wrap(<Deals />, wrapped((m, p) => (p === "/deals" ? err(500) : undefined)));
    await screen.findByTestId("deals-retry");
  });
  test("no access says so", async () => {
    await wrap(<Deals />, wrapped((m, p) => (p === "/deals" ? err(403) : undefined)));
    await screen.findByText("Deals aren't open to you");
  });
});

describe("Expenses", () => {
  test("helpers", () => {
    expect(cents(8640)).toMatch(/86\.40/);
    expect(cents(null)).toBe("No total yet");
    expect(statusOf("submitted").label).toBe("Waiting for approval");
    expect(canSubmit({ id: "x", own: true, status: "draft", totalCents: 100, createdAt: "" })).toBe(true);
    expect(canSubmit({ id: "x", own: false, status: "draft", totalCents: 100, createdAt: "" })).toBe(false);
    expect(receiptUploadPath("my receipt.jpg")).toBe("/api/expenses/upload?source=upload&name=my%20receipt.jpg");
  });
  test("mine and to approve, add a receipt from files", async () => {
    await wrap(<Expenses />);
    await screen.findByTestId("expenses-screen");
    expect(screen.getByTestId("expense-exp_s1")).toBeTruthy();
    expect(screen.queryByTestId("expense-exp_s4")).toBeNull();
    fireEvent.press(screen.getByText("To approve (1)"));
    await screen.findByTestId("expense-exp_s4");
    fireEvent.press(screen.getByText("Mine"));
    await screen.findByTestId("expenses-add");
    mockPick.mockResolvedValueOnce({ canceled: false, assets: [{ uri: "file:///r.jpg", name: "r.jpg", size: 1000, mimeType: "image/jpeg" }] });
    fireEvent.press(screen.getByTestId("expenses-add"));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith({ pathname: "/expense/[id]", params: { id: "exp_n1" } }));
  });
  test("detail submits a draft", async () => {
    mockParams = { id: "exp_s1" };
    await wrap(<ExpenseScreen />);
    await screen.findByTestId("expense-screen");
    fireEvent.press(screen.getByTestId("expense-submit"));
    await screen.findByTestId("expense-withdraw");
  });
  test("switched off shows a plain note", async () => {
    await wrap(<Expenses />, wrapped((m, p) => (p.startsWith("/expenses") ? err(404) : undefined)));
    await screen.findByText("Expenses are off for this workspace");
  });
});

describe("M2 dayLabel (spend dates are days, never a clock time)", () => {
  const { dayLabel } = require("@/lib/format");
  const now = new Date(2026, 10, 2, 9, 30);
  it("says Today and Yesterday, never a time", () => {
    expect(dayLabel("2026-11-02", now)).toBe("Today");
    expect(dayLabel("2026-11-01", now)).toBe("Yesterday");
    expect(dayLabel("2026-10-27", now)).not.toMatch(/am|pm|:/i);
  });
});
