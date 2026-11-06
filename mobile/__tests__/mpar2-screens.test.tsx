/** MPAR2: the new settings screens render on the sample workspace and do what they say. */
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SessionProvider } from "@/lib/session";
import { SampleTransport } from "@/sample/transport";
import { planStatusLine, stepTarget, usageRows, passwordProblem, cleanName, checklistVisible, canChangePassword } from "@/lib/mpar2";
import { savedChoice } from "@/i18n";
import { savedAccent, savedMode } from "@/theme";
import { resetPrefsForTests } from "@/lib/startup-prefs";

const mockPush = jest.fn();
const mockBack = jest.fn();
jest.mock("expo-router", () => ({
  router: { push: (...a: unknown[]) => mockPush(...a), back: () => mockBack(), replace: jest.fn() },
  useLocalSearchParams: () => ({}),
  Stack: { Screen: () => null },
}));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }), SafeAreaView: ({ children }: { children: ReactNode }) => children }));

let transport: SampleTransport;
async function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><SessionProvider initialMode="sample" transportOverride={transport}>{ui}</SessionProvider></QueryClientProvider>);
}
beforeEach(() => { transport = new SampleTransport(); mockPush.mockClear(); mockBack.mockClear(); resetPrefsForTests(); });

it("Settings links to account, plan, Get started, language and appearance", async () => {
  const Settings = require("@/app/settings").default;
  await wrap(<Settings />);
  await fireEvent.press(await screen.findByTestId("account-link"));
  expect(mockPush).toHaveBeenCalledWith("/account");
  await fireEvent.press(await screen.findByTestId("get-started-link"));
  expect(mockPush).toHaveBeenCalledWith("/get-started");
  await fireEvent.press(screen.getByTestId("language-link"));
  expect(mockPush).toHaveBeenCalledWith("/language");
  await fireEvent.press(screen.getByTestId("appearance-link"));
  expect(mockPush).toHaveBeenCalledWith("/appearance");
  await fireEvent.press(screen.getByTestId("billing-link"));
  expect(mockPush).toHaveBeenCalledWith("/billing");
});

it("Language keeps the pick on the phone", async () => {
  const Language = require("@/app/language").default;
  await wrap(<Language />);
  await fireEvent.press(screen.getByTestId("language-ne"));
  await waitFor(() => expect(savedChoice()).toBe("ne"));
  await fireEvent.press(screen.getByTestId("language-system"));
  await waitFor(() => expect(savedChoice()).toBe("system"));
});

it("Appearance keeps the mode and the accent", async () => {
  const Appearance = require("@/app/appearance").default;
  await wrap(<Appearance />);
  await fireEvent.press(screen.getByTestId("accent-forest"));
  await waitFor(() => expect(savedAccent()).toBe("forest"));
  await fireEvent.press(screen.getByTestId("appearance-light"));
  await waitFor(() => expect(savedMode()).toBe("light"));
  expect(screen.getByTestId("appearance-preview")).toBeTruthy();
});

it("Plan and usage is read only, with usage meters and no purchase link (App Store 3.1.1)", async () => {
  const Billing = require("@/app/billing").default;
  await wrap(<Billing />);
  expect(await screen.findByText("Free")).toBeTruthy();
  expect(screen.getByTestId("billing-status")).toHaveTextContent("Free plan. No card needed.");
  expect(screen.getByTestId("billing-mailboxes")).toBeTruthy();
  expect(screen.queryByText(/upgrade|buy|checkout|billing|subscribe/i)).toBeNull();
  expect(screen.queryByTestId("billing-web")).toBeNull();
});

it("Get started lists the steps and opens the app screen for one", async () => {
  const GetStarted = require("@/app/get-started").default;
  await wrap(<GetStarted />);
  expect(await screen.findByTestId("started-count")).toHaveTextContent("2 of 5 done");
  await fireEvent.press(screen.getByTestId("started-task"));
  expect(mockPush).toHaveBeenCalledWith("/tasks");
});

it("Account shows the name and the password form", async () => {
  const Account = require("@/app/account").default;
  await wrap(<Account />);
  expect(await screen.findByDisplayValue("Mia Nguyen")).toBeTruthy();
  expect(screen.getByTestId("account-current")).toBeTruthy();
});

describe("helpers", () => {
  it("usage rows and plan lines", () => {
    const rows = usageRows({ usage: { domains: 1, mailboxes: 3, seats: 4, sendsToday: 12, storageMb: 2048 }, limits: { domains: 1, mailboxes: 5, seats: 5, dailySends: 100, storageMb: 5120 } });
    expect(rows.map((r) => r.text)).toEqual(["1 of 1", "3 of 5", "4 of 5", "2 GB of 5 GB", "12 of 100"]);
    expect(planStatusLine({ plan: { id: "pro", name: "Pro" }, interval: "month", dunning: null, subscription: { status: "active", currentPeriodEnd: "2026-12-01T00:00:00Z", cancelAtPeriodEnd: false } }, "en-AU").text).toMatch(/^Renews monthly on 1 December 2026/);
    expect(planStatusLine({ plan: { id: "pro", name: "Pro" }, interval: "month", dunning: { pastDueSince: "x", graceEndsAt: null, sendingPaused: true }, subscription: null }, "en-AU").tone).toBe("bad");
  });
  it("step targets", () => {
    expect(stepTarget({ to: "/app/tasks" })).toEqual({ kind: "screen", href: "/tasks" });
    expect(stepTarget({ to: "/app/settings/team" })).toEqual({ kind: "web", path: "/app/settings/team" });
    expect(stepTarget({ action: "palette" })).toEqual({ kind: "command" });
    expect(checklistVisible({ steps: [], doneCount: 1, total: 1, complete: true, dismissed: false, celebrated: true })).toBe(false);
  });
  it("account rules", () => {
    expect(passwordProblem("", "x")).toBe("Enter your current password.");
    expect(passwordProblem("old", "short")).toBe("At least 10 characters.");
    expect(passwordProblem("samesamesame", "samesamesame")).toMatch(/different/);
    expect(passwordProblem("old", "a much longer one")).toBeNull();
    expect(cleanName("  Mia   Nguyen ")).toBe("Mia Nguyen");
    expect(cleanName("   ")).toBeNull();
    expect(canChangePassword({ hasPassword: false, user: {} })).toBe(false);
    expect(canChangePassword(undefined)).toBe(true);
  });
});
