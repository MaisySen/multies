/**
 * R31 smoke tests against the sample workspace: the Activity (triage) tab, long-press menus on task
 * and mail rows from the command registry, the snooze picker, Undo, the command sheet, the run
 * Cancel button, and the plain-list fallback for a server that ignores ?view=.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Alert } from "react-native";
import type { ReactNode } from "react";
import { SessionProvider } from "@/lib/session";
import { SampleTransport } from "@/sample/transport";
import { openCommandSheet, closeCommandSheet } from "@/lib/command-sheet-store";
import type { Method } from "@/api/transport";

const mockPush = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock("expo-router", () => ({
  router: { push: (...a: unknown[]) => mockPush(...a), back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => mockParams,
  useIsFocused: () => true,
  Stack: { Screen: () => null },
}));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }), SafeAreaView: ({ children }: { children: ReactNode }) => children }));

let transport: SampleTransport;
const clients: QueryClient[] = [];
async function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(qc);
  return render(<QueryClientProvider client={qc}><SessionProvider initialMode="sample" transportOverride={transport}>{ui}</SessionProvider></QueryClientProvider>);
}
const get = <T,>(path: string) => transport.request<T>("GET", path);

afterEach(() => { while (clients.length) clients.pop()!.clear(); jest.useRealTimers(); closeCommandSheet(); });
beforeEach(() => { transport = new SampleTransport(); mockPush.mockClear(); mockParams = {}; });

it("Activity tab: Inbox, Later and Done with counts; long-press Mark done hides the row with Undo, then saves", async () => {
  const Activity = require("@/app/(tabs)/activity").default;
  await wrap(<Activity />);
  expect(await screen.findByText("Josh Tran mentioned you in #general")).toBeTruthy();
  expect(screen.getByLabelText("Inbox 7")).toBeTruthy();
  expect(screen.getByText("Later")).toBeTruthy();

  await fireEvent(screen.getByTestId("notification-ntf_1"), "longPress");
  expect(await screen.findByTestId("triage-actions")).toBeTruthy();
  expect(screen.getByText("Open")).toBeTruthy();
  await fireEvent.press(screen.getByTestId("sheet-triage-done"));
  await waitFor(() => expect(screen.queryByTestId("notification-ntf_1")).toBeNull());
  expect(screen.getByTestId("undo-toast")).toBeTruthy();

  // Undo brings it back and nothing is saved.
  await fireEvent.press(screen.getByTestId("undo"));
  expect(await screen.findByTestId("notification-ntf_1")).toBeTruthy();
  expect((await get<{ viewCounts: { done: number } }>("/notifications?view=done")).viewCounts.done).toBe(0);

  // Again, and let the window close: it moves to Done on the server.
  jest.useFakeTimers();
  await fireEvent(screen.getByTestId("notification-ntf_1"), "longPress");
  await fireEvent.press(await screen.findByTestId("sheet-triage-done"));
  await act(async () => { jest.advanceTimersByTime(5100); });
  jest.useRealTimers();
  await waitFor(async () => expect((await get<{ viewCounts: { done: number } }>("/notifications?view=done")).viewCounts.done).toBe(1));
});

it("Activity tab: snooze from the long-press menu offers the three presets and moves the item to Later", async () => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
  const Activity = require("@/app/(tabs)/activity").default;
  await wrap(<Activity />);
  await act(async () => { jest.advanceTimersByTime(10); });
  await fireEvent(await screen.findByTestId("notification-ntf_2"), "longPress");
  await fireEvent.press(await screen.findByTestId("sheet-triage-snooze"));
  expect(await screen.findByTestId("snooze-sheet")).toBeTruthy();
  for (const l of ["Later today", "Tomorrow", "Next week"]) expect(screen.getByText(l)).toBeTruthy();
  await fireEvent.press(screen.getByTestId("sheet-tomorrow"));
  expect(await screen.findByText("Snoozed until tomorrow")).toBeTruthy();
  await act(async () => { jest.advanceTimersByTime(5100); });
  jest.useRealTimers();
  await waitFor(async () => expect((await get<{ notifications: { id: string }[] }>("/notifications?view=later")).notifications.map((n) => n.id)).toEqual(["ntf_2"]));
});

it("falls back to the plain list when the server ignores ?view= (no Later or Done)", async () => {
  const real = transport.request.bind(transport);
  transport.request = (async (method: Method, path: string, body?: unknown) => {
    const r = await real(method, path.replace(/view=\w+&?/, ""), body);
    if (method === "GET" && path.startsWith("/notifications") && r && typeof r === "object") delete (r as { viewCounts?: unknown }).viewCounts;
    return r;
  }) as typeof transport.request;
  const Notifications = require("@/app/notifications").default;
  await wrap(<Notifications />);
  expect(await screen.findByText("Josh Tran mentioned you in #general")).toBeTruthy();
  expect(screen.getByTestId("mark-all-read")).toBeTruthy();
  expect(screen.queryByText("Later")).toBeNull();
  expect(screen.queryByText("Done")).toBeNull();
});

it("tasks: long-press opens the registry's task actions and a picker that saves the change", async () => {
  const Tasks = require("@/app/(tabs)/tasks").default;
  await wrap(<Tasks />);
  const rows = await screen.findAllByTestId(/^task-row-/);
  const id = rows[0].props.testID.replace("task-row-", "");
  await fireEvent(rows[0], "longPress");
  expect(await screen.findByTestId("task-actions")).toBeTruthy();
  for (const l of ["Change status", "Assign to", "Set priority", "Add a label", "Set due date"]) expect(screen.getByText(l)).toBeTruthy();
  await fireEvent.press(screen.getByTestId("sheet-task-priority"));
  expect(await screen.findByTestId("task-pick-priority")).toBeTruthy();
  await fireEvent.press(screen.getByTestId("sheet-urgent"));
  await waitFor(async () => expect((await get<{ task: { priority: string } }>(`/tasks/${id}`)).task.priority).toBe("urgent"));

  await fireEvent(screen.getByTestId(`task-row-${id}`), "longPress");
  await fireEvent.press(await screen.findByTestId("sheet-task-label"));
  await fireEvent.changeText(screen.getByTestId("new-label"), "wholesale");
  await fireEvent(screen.getByTestId("new-label"), "submitEditing");
  await waitFor(async () => expect((await get<{ task: { labels: string[] } }>(`/tasks/${id}`)).task.labels).toContain("wholesale"));
});

it("mail: long-press shows Reply, Archive, Snooze, Star, Mark read or unread, Move to trash; Archive hides with Undo then saves", async () => {
  const Inbox = require("@/app/(tabs)/inbox").default;
  await wrap(<Inbox />);
  const row = await screen.findByText("Wholesale order for Saturday markets");
  await fireEvent(row, "longPress");
  expect(await screen.findByTestId("mail-actions")).toBeTruthy();
  for (const id of ["reply", "archive", "snooze", "star", "read", "trash"]) expect(screen.getByTestId(`sheet-mail-${id}`)).toBeTruthy();
  expect(screen.getByText("Move to trash")).toBeTruthy();
  expect(screen.getByText(/^(Star|Unstar)$/)).toBeTruthy();
  expect(screen.getByText(/^Mark (read|unread)$/)).toBeTruthy();

  await fireEvent.press(screen.getByTestId("sheet-mail-reply"));
  expect(mockPush).toHaveBeenCalledWith({ pathname: "/compose", params: { replyTo: "msg_1" } });

  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
  await fireEvent(screen.getByText("Wholesale order for Saturday markets"), "longPress");
  await fireEvent.press(await screen.findByTestId("sheet-mail-archive"));
  expect(await screen.findByText("Archived")).toBeTruthy();
  await act(async () => { jest.advanceTimersByTime(5100); });
  jest.useRealTimers();
  await waitFor(async () => expect((await get<{ messages: { id: string }[] }>("/mail/messages?folder=archive")).messages.map((m) => m.id)).toContain("msg_1"));
});

it("command sheet lists go-to and app commands, filters, and runs one", async () => {
  const { CommandSheet } = require("@/components/command-sheet");
  await wrap(<CommandSheet />);
  await act(async () => openCommandSheet());
  expect(await screen.findByTestId("command-sheet")).toBeTruthy();
  for (const l of ["Go to Mail", "Go to Tasks", "Go to Docs", "Go to Chat", "Go to Meetings", "Go to Notifications", "Write an email"]) expect(screen.getByText(l)).toBeTruthy();
  await act(async () => { fireEvent.changeText(screen.getByTestId("command-search"), "meet"); });
  await waitFor(() => expect(screen.queryAllByTestId(/^command-go/).map((x) => x.props.testID)).toEqual(["command-go-m"]));
  await fireEvent.press(screen.getByTestId("command-go-m"));
  await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/meetings"));
});

it("run detail: Cancel run asks first, then cancels a running run", async () => {
  const runs = (await get<{ runs: { id: string; status: string }[] }>("/agent-runs")).runs;
  const live = runs.find((r) => r.status === "running" || r.status === "queued");
  if (!live) return;
  mockParams = { id: live.id };
  const spy = jest.spyOn(Alert, "alert").mockImplementation((_t, _m, buttons) => { buttons?.find((b) => b.style === "destructive")?.onPress?.(); });
  const Run = require("@/app/run/[id]").default;
  await wrap(<Run />);
  await fireEvent.press(await screen.findByTestId("run-cancel", {}, { timeout: 5000 }));
  expect(spy).toHaveBeenCalledWith("Cancel this run?", expect.any(String), expect.any(Array));
  await waitFor(async () => expect((await get<{ run: { status: string } }>(`/agent-runs/${live.id}`)).run.status).toBe("cancelled"));
  await waitFor(() => expect(screen.queryByTestId("run-cancel")).toBeNull());
  spy.mockRestore();
});
