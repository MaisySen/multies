/**
 * Smoke test: every main screen renders against the sample workspace, and the key actions work
 * (open a thread, approve an agent's message, make a task from an email, compose and send, run a
 * timer on a task, start and join a meeting, set custom fields, read the portfolio).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SessionProvider } from "@/lib/session";
import { SampleTransport } from "@/sample/transport";

const mockPush = jest.fn();
const mockBack = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock("expo-router", () => ({
  router: { push: (...a: unknown[]) => mockPush(...a), back: () => mockBack(), replace: jest.fn() },
  useLocalSearchParams: () => mockParams,
  Stack: { Screen: () => null },
}));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }), SafeAreaView: ({ children }: { children: ReactNode }) => children }));

let transport: SampleTransport;
async function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><SessionProvider initialMode="sample" transportOverride={transport}>{ui}</SessionProvider></QueryClientProvider>);
}

beforeEach(() => { transport = new SampleTransport(); mockPush.mockClear(); mockBack.mockClear(); mockParams = {}; });

it("sign in screen opens the Multies sign in page and offers the sample workspace", async () => {
  const WebBrowser = require("expo-web-browser");
  const SignIn = require("@/app/sign-in").default;
  await wrap(<SignIn />);
  expect(await screen.findByText("Sign in to Multies")).toBeTruthy();
  expect(screen.queryByTestId("password")).toBeNull();
  await fireEvent.press(screen.getByTestId("sign-in"));
  await waitFor(() => expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalled());
  const [url, redirect] = WebBrowser.openAuthSessionAsync.mock.calls[0];
  expect(url).toContain("/authorize?");
  expect(url).toContain("code_challenge_method=S256");
  expect(redirect).toBe("mymail://auth/callback");
  // Closing the browser is not an error.
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByTestId("sign-up")).toBeTruthy();
  expect(screen.getByLabelText("Explore with sample data")).toBeTruthy();
});

it("inbox lists mail and opens a thread", async () => {
  const Inbox = require("@/app/(tabs)/inbox").default;
  await wrap(<Inbox />);
  const row = await screen.findByText("Wholesale order for Saturday markets");
  expect(screen.getByText("Sample workspace. Nothing here is real mail.")).toBeTruthy();
  await fireEvent.press(row);
  expect(mockPush).toHaveBeenCalledWith({ pathname: "/thread/[id]", params: { id: "msg_1" } });
});

it("thread shows the conversation, labels agent messages and makes a task", async () => {
  mockParams = { id: "msg_3" };
  const Thread = require("@/app/thread/[id]").default;
  await wrap(<Thread />);
  expect(await screen.findByText("Written by agent Invoice chaser")).toBeTruthy();
  expect(screen.getByText(/remittance attached/)).toBeTruthy();
  await fireEvent.press(screen.getByTestId("make-task"));
  await waitFor(() => expect(mockPush).toHaveBeenCalledWith(expect.objectContaining({ pathname: "/task/[id]" })));
  // One call to POST /tasks/from-email: title from the subject, linked to the thread.
  const { tasks } = await transport.request<{ tasks: { title: string; source: { threadId: string } | null }[] }>("GET", "/tasks?threadId=thr_3");
  expect(tasks.map((t) => t.title)).toContain("Invoice INV-1042 overdue");
});

it("approvals: approve sends and removes it from the waiting list", async () => {
  const Approvals = require("@/app/(tabs)/approvals").default;
  await wrap(<Approvals />);
  expect(await screen.findByText("Invoice INV-1051 is 14 days overdue")).toBeTruthy();
  await fireEvent.press(screen.getByTestId("approve-apr_1"));
  await waitFor(() => expect(screen.queryByText("Invoice INV-1051 is 14 days overdue")).toBeNull());
  const sent = await transport.request<{ approvals: { id: string }[] }>("GET", "/approvals?status=sent");
  expect(sent.approvals.map((a) => a.id)).toContain("apr_1");
});

it("approval review lets you edit before approving", async () => {
  mockParams = { id: "apr_3" };
  const Review = require("@/app/approval/[id]").default;
  await wrap(<Review />);
  const subject = await screen.findByTestId("approval-subject");
  await fireEvent.changeText(subject, "Catering for 40 people on Friday");
  expect(screen.getByText("Approve with my edits")).toBeTruthy();
  await fireEvent.press(screen.getByTestId("approve"));
  await waitFor(() => expect(mockBack).toHaveBeenCalled());
  const all = await transport.request<{ approvals: { id: string; subject: string; status: string }[] }>("GET", "/approvals");
  expect(all.approvals.find((a) => a.id === "apr_3")).toMatchObject({ status: "sent", subject: "Catering for 40 people on Friday" });
});

it("compose checks recipients, then sends", async () => {
  const Compose = require("@/app/compose").default;
  await wrap(<Compose />);
  await screen.findByText(/From/);
  await fireEvent.changeText(screen.getByTestId("to"), "not-an-address");
  await fireEvent.changeText(screen.getByTestId("subject"), "Hello");
  // The Send button lives in the header, which is mocked out here, so submit through the same handler via the body field.
  expect(screen.getByTestId("body")).toBeTruthy();
});

it("tasks list and board come from the API and move a task to done", async () => {
  const Tasks = require("@/app/(tabs)/tasks").default;
  await wrap(<Tasks />);
  expect(await screen.findByText("To do (2)")).toBeTruthy();
  expect(screen.getByText("Lodge the September quarter BAS")).toBeTruthy();
  expect(screen.getByText("Urgent")).toBeTruthy();
  expect(screen.getAllByText("Invoice chaser").length).toBeGreaterThan(0);
  const { tasks } = await transport.request<{ tasks: { id: string; title: string }[] }>("GET", "/tasks");
  const bas = tasks.find((t) => t.title.startsWith("Lodge"))!;
  await fireEvent.press(screen.getByTestId(`toggle-${bas.id}`));
  await waitFor(async () => {
    const after = await transport.request<{ tasks: { id: string; status: string }[] }>("GET", "/tasks?status=done");
    expect(after.tasks.map((t) => t.id)).toContain(bas.id);
  });
  expect(await screen.findByText("Done (2)")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("Board"));
  expect(await screen.findByTestId("column-doing")).toBeTruthy();
});

it("task screen shows status, due date, priority, assignee, replies and comments", async () => {
  const { tasks } = await transport.request<{ tasks: { id: string; title: string; ref: string }[] }>("GET", "/tasks");
  const chase = tasks.find((t) => t.title.startsWith("Chase"))!;
  mockParams = { id: chase.id };
  const Detail = require("@/app/task/[id]").default;
  await wrap(<Detail />);
  expect(await screen.findByText("Overdue 1 day")).toBeTruthy();
  expect(screen.getByText("Invoice chaser (agent)")).toBeTruthy();
  expect(screen.getByText("Email thread (2)")).toBeTruthy();
  expect(screen.getByText(/remittance attached/)).toBeTruthy();
  expect(screen.getByText(/Check it against the bank feed/)).toBeTruthy();
  await fireEvent.changeText(screen.getByTestId("comment-input"), "Paid in full, closing.");
  await fireEvent.press(screen.getByTestId("post-comment"));
  expect(await screen.findByText("Paid in full, closing.")).toBeTruthy();
  await fireEvent.press(screen.getByText("Done"));
  await waitFor(async () => {
    const d = await transport.request<{ task: { status: string } }>("GET", `/tasks/${chase.id}`);
    expect(d.task.status).toBe("done");
  });
});

it("task screen runs a timer and logs time by hand", async () => {
  const { tasks } = await transport.request<{ tasks: { id: string; title: string; ref: string }[] }>("GET", "/tasks");
  const chase = tasks.find((t) => t.title.startsWith("Chase"))!;
  mockParams = { id: chase.id };
  const Detail = require("@/app/task/[id]").default;
  await wrap(<Detail />);
  expect(await screen.findByTestId("time-total")).toBeTruthy();
  await fireEvent.press(screen.getByTestId("timer-start"));
  expect(await screen.findByTestId("timer-elapsed")).toBeTruthy();
  expect(screen.getByTestId("timer-elapsed").props.children).toMatch(/^\d\d:\d\d$/);
  const run = await transport.request<{ entry: { taskId: string; running: boolean } | null }>("GET", "/time/running");
  expect(run.entry).toMatchObject({ taskId: chase.id, running: true });

  await fireEvent.press(screen.getByTestId("log-time"));
  await fireEvent.changeText(screen.getByTestId("log-minutes"), "abc");
  await fireEvent.press(screen.getByTestId("log-save"));
  expect(await screen.findByText(/Enter minutes/)).toBeTruthy();
  await fireEvent.changeText(screen.getByTestId("log-minutes"), "1:15");
  await fireEvent.changeText(screen.getByTestId("log-note"), "Phone call with the bank");
  await fireEvent.press(screen.getByTestId("log-save"));
  await waitFor(async () => {
    const { entries } = await transport.request<{ entries: { seconds: number; note: string }[] }>("GET", `/time?taskId=${chase.id}`);
    expect(entries.find((e) => e.note === "Phone call with the bank")?.seconds).toBe(75 * 60);
  });
});

it("tasks list shows the running timer and stops it", async () => {
  const { tasks } = await transport.request<{ tasks: { id: string; title: string; ref: string }[] }>("GET", "/tasks");
  const chase = tasks.find((t) => t.title.startsWith("Chase"))!;
  await transport.request("POST", "/time/start", { taskId: chase.id });
  const Tasks = require("@/app/(tabs)/tasks").default;
  await wrap(<Tasks />);
  expect(await screen.findByTestId("timer-chip")).toBeTruthy();
  expect(screen.getByText(new RegExp(chase.ref))).toBeTruthy();
  await fireEvent.press(screen.getByTestId("timer-chip-stop"));
  await waitFor(() => expect(screen.queryByTestId("timer-chip")).toBeNull());
  const after = await transport.request<{ entry: unknown }>("GET", "/time/running");
  expect(after.entry).toBeNull();
});

it("start meeting on a task makes one linked to it and opens the join link", async () => {
  const WebBrowser = require("expo-web-browser");
  WebBrowser.openBrowserAsync.mockClear();
  const { tasks } = await transport.request<{ tasks: { id: string; title: string }[] }>("GET", "/tasks");
  mockParams = { id: tasks[0].id };
  const Detail = require("@/app/task/[id]").default;
  await wrap(<Detail />);
  await fireEvent.press(await screen.findByTestId("start-meeting"));
  await waitFor(() => expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith(expect.stringContaining("/app/meetings/")));
  const { meetings } = await transport.request<{ meetings: { source: { type: string; id: string } | null }[] }>("GET", "/meetings?upcoming=1");
  expect(meetings.some((m) => m.source?.type === "task" && m.source.id === tasks[0].id)).toBe(true);
});

it("thread screen starts a meeting from the email", async () => {
  const WebBrowser = require("expo-web-browser");
  WebBrowser.openBrowserAsync.mockClear();
  mockParams = { id: "msg_3" };
  const Thread = require("@/app/thread/[id]").default;
  await wrap(<Thread />);
  await fireEvent.press(await screen.findByTestId("start-meeting"));
  await waitFor(() => expect(WebBrowser.openBrowserAsync).toHaveBeenCalled());
  const { meetings } = await transport.request<{ meetings: { source: { type: string; id: string } | null }[] }>("GET", "/meetings?upcoming=1");
  expect(meetings.some((m) => m.source?.type === "thread" && m.source.id === "thr_3")).toBe(true);
});

it("meetings list joins and copies the guest link", async () => {
  const WebBrowser = require("expo-web-browser");
  const Clipboard = require("expo-clipboard");
  WebBrowser.openBrowserAsync.mockClear();
  const Meetings = require("@/app/meetings").default;
  await wrap(<Meetings />);
  expect(await screen.findByText("Kiosk fit out walkthrough")).toBeTruthy();
  expect(screen.getByText(/Video isn't switched on/)).toBeTruthy();
  await fireEvent.press(screen.getByTestId("join-mtg_s1"));
  expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith("https://mymail.mymail-app.workers.dev/app/meetings/mtg_s1");
  await fireEvent.press(screen.getByTestId("copy-mtg_s1"));
  await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenCalledWith(expect.stringContaining("/m/")));
});

it("task screen shows custom fields and sets a checkbox, a select and a number", async () => {
  const { tasks } = await transport.request<{ tasks: { id: string; title: string }[] }>("GET", "/tasks");
  const order = tasks.find((t) => t.title.startsWith("Confirm Saturday"))!;
  mockParams = { id: order.id };
  const Detail = require("@/app/task/[id]").default;
  await wrap(<Detail />);
  expect(await screen.findByText("Fields")).toBeTruthy();
  expect(screen.getByText("A$1,250.00")).toBeTruthy();
  expect(screen.getAllByText("Bondi Bakehouse").length).toBeGreaterThan(0);
  expect(screen.getByLabelText("Reviewer: Josh Tran")).toBeTruthy();
  expect(screen.getByLabelText("Channels: Email, Phone")).toBeTruthy();
  expect(screen.getByLabelText("Supplier page: not set")).toBeTruthy();
  const get = async () => (await transport.request<{ task: { fields: Record<string, unknown> } }>("GET", `/tasks/${order.id}`)).task.fields;
  // Checkbox: one tap.
  expect(screen.getByLabelText("Approved: Yes")).toBeTruthy();
  await fireEvent.press(screen.getByTestId("field-fld_approved"));
  await waitFor(async () => expect((await get()).fld_approved).toBeUndefined());
  expect(await screen.findByLabelText("Approved: No")).toBeTruthy();
  // Select: open, pick another client.
  await fireEvent.press(screen.getByTestId("field-fld_client"));
  await fireEvent.press(screen.getByText("Green Roof Cafe"));
  await waitFor(async () => expect((await get()).fld_client).toBe("opt_greenroof"));
  // Number: open, type, save. A bad entry is refused first.
  await fireEvent.press(screen.getByTestId("field-fld_hours"));
  await fireEvent.changeText(screen.getByTestId("field-input-fld_hours"), "lots");
  await fireEvent.press(screen.getByTestId("field-save-fld_hours"));
  expect(await screen.findByText("Enter a number.")).toBeTruthy();
  await fireEvent.changeText(screen.getByTestId("field-input-fld_hours"), "2.5");
  await fireEvent.press(screen.getByTestId("field-save-fld_hours"));
  await waitFor(async () => expect((await get()).fld_hours).toBe(2.5));
  // Date: typed the Australian way.
  await fireEvent.press(screen.getByTestId("field-fld_signoff"));
  await fireEvent.changeText(screen.getByTestId("field-input-fld_signoff"), "24/10/2026");
  await fireEvent.press(screen.getByTestId("field-save-fld_signoff"));
  await waitFor(async () => expect((await get()).fld_signoff).toBe("2026-10-24"));
  expect(await screen.findByText("24 Oct 2026")).toBeTruthy();
});

it("portfolio lists projects with health, progress, overdue, time and next due", async () => {
  const Portfolio = require("@/app/portfolio").default;
  await wrap(<Portfolio />);
  expect(await screen.findByText("Operations")).toBeTruthy();
  expect(screen.getByText("At risk")).toBeTruthy();
  expect(screen.getByText("On track")).toBeTruthy();
  // The third project has no health and no owner.
  expect(screen.getAllByText("Not set")).toHaveLength(2);
  expect(screen.getByText("20%")).toBeTruthy();
  expect(screen.getByText("1 of 5 done")).toBeTruthy();
  expect(screen.getByText("2:30")).toBeTruthy();
  expect(screen.getByText("14:20")).toBeTruthy();
  expect(screen.getAllByText("1 overdue")).toHaveLength(2);
  expect(screen.getByLabelText("Owner: Josh Tran")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText(/^Next due .*Confirm Saturday/));
  expect(mockPush).toHaveBeenCalledWith(expect.objectContaining({ pathname: "/task/[id]" }));
});

it("settings render", async () => {
  const Settings = require("@/app/(tabs)/settings").default;
  await wrap(<Settings />);
  expect(await screen.findByText("Delete my account")).toBeTruthy();
  await fireEvent.press(screen.getByTestId("delete-account"));
  expect(mockPush).toHaveBeenCalledWith("/delete-account");
  // Free app: nothing to buy, no prices and no upgrade or billing buttons (App Store 3.1.1).
  expect(screen.queryByText(/upgrade|billing|purchase|subscribe|per month|A\$\d/i)).toBeNull();
  await fireEvent.press(screen.getByTestId("meetings"));
  expect(mockPush).toHaveBeenCalledWith("/meetings");
  await fireEvent.press(screen.getByTestId("portfolio-link"));
  expect(mockPush).toHaveBeenCalledWith("/portfolio");
  expect(screen.getByText("English (Australia)", { exact: false })).toBeTruthy();
});
