/**
 * Smoke tests for team chat and the notifications inbox against the sample workspace: the channel
 * list, a channel with mentions and chips, the mention picker, Make task, a thread, the DM
 * starter, push routing through the message screen, the inbox and its settings.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SessionProvider } from "@/lib/session";
import { SampleTransport } from "@/sample/transport";

const mockPush = jest.fn();
const mockReplace = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock("expo-router", () => ({
  router: { push: (...a: unknown[]) => mockPush(...a), back: jest.fn(), replace: (...a: unknown[]) => mockReplace(...a) },
  useLocalSearchParams: () => mockParams,
  useIsFocused: () => true,
  Stack: { Screen: () => null },
}));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }), SafeAreaView: ({ children }: { children: ReactNode }) => children }));

let transport: SampleTransport;
const clients: QueryClient[] = [];
async function wrap(ui: ReactNode) {
  // No garbage collection timer, so nothing keeps the test process alive once screens unmount.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(qc);
  return render(<QueryClientProvider client={qc}><SessionProvider initialMode="sample" transportOverride={transport}>{ui}</SessionProvider></QueryClientProvider>);
}
const get = <T,>(path: string) => transport.request<T>("GET", path);

afterEach(() => { while (clients.length) clients.pop()!.clear(); });
beforeEach(() => { transport = new SampleTransport(); mockPush.mockClear(); mockReplace.mockClear(); mockParams = {}; });

it("chat list shows channels, then DMs, with unread counts and mentions, and opens a channel", async () => {
  const Chat = require("@/app/(tabs)/chat").default;
  await wrap(<Chat />);
  expect(await screen.findByText("Channels")).toBeTruthy();
  expect(screen.getByText("Direct messages")).toBeTruthy();
  expect(screen.getByLabelText("#general, 2 unread, 2 mentions")).toBeTruthy();
  expect(within(screen.getByTestId("mentions-chn_general")).getByText("@2")).toBeTruthy();
  expect(screen.getByLabelText("Josh Tran, 1 unread")).toBeTruthy();
  expect(screen.getByLabelText("#markets")).toBeTruthy();
  await fireEvent.press(screen.getByTestId("channel-chn_general"));
  expect(mockPush).toHaveBeenCalledWith({ pathname: "/chat/[id]", params: { id: "chn_general" } });
  await fireEvent.press(screen.getByTestId("new-dm-button"));
  expect(mockPush).toHaveBeenCalledWith("/chat/new");
});

it("channel shows messages oldest first with @mentions, chips and files, and marks the channel read", async () => {
  mockParams = { id: "chn_general" };
  const Channel = require("@/app/chat/[id]").default;
  await wrap(<Channel />);
  expect(await screen.findByText(/roaster is booked/)).toBeTruthy();
  expect(screen.getAllByText("@Mia Nguyen").length).toBeGreaterThan(0);
  expect(screen.getByText("@channel")).toBeTruthy();
  expect(screen.getByText("2 replies")).toBeTruthy();
  expect(screen.getByLabelText(/Attachment packing-slip-bondi.pdf/)).toBeTruthy();
  const ids = (await get<{ messages: { id: string; body: string }[] }>("/chat/channels/chn_general/messages")).messages.map((m) => m.id);
  const rows = screen.getAllByTestId(/^chat-msg-/).map((r) => r.props.testID.replace("chat-msg-", ""));
  expect(rows).toEqual(ids);
  await waitFor(async () => expect((await get<{ total: number }>("/chat/unread")).total).toBe(1));
  const chip = screen.getAllByTestId(/^chip-task-/)[0];
  await fireEvent.press(chip);
  expect(mockPush).toHaveBeenCalledWith({ pathname: "/task/[id]", params: { id: expect.stringMatching(/^tsk_/) } });
  await fireEvent.press(screen.getByText("2 replies"));
  expect(mockPush).toHaveBeenCalledWith({ pathname: "/chat/thread/[id]", params: { id: expect.any(String) } });
});

it("composer picks a mention and sends it as markup", async () => {
  mockParams = { id: "chn_markets" };
  const Channel = require("@/app/chat/[id]").default;
  await wrap(<Channel />);
  const box = await screen.findByTestId("composer");
  await fireEvent.changeText(box, "Grinder is in the van @jo");
  await fireEvent.press(await screen.findByTestId("mention-member:usr_josh"));
  expect(box.props.value).toBe("Grinder is in the van @Josh Tran ");
  await fireEvent.press(screen.getByTestId("composer-send"));
  expect(await screen.findByText("Grinder is in the van ")).toBeTruthy();
  const { messages } = await get<{ messages: { body: string; mentions: { name: string }[] }[] }>("/chat/channels/chn_markets/messages");
  const last = messages[messages.length - 1];
  expect(last.body).toBe("Grinder is in the van <@member:usr_josh>");
  expect(last.mentions[0].name).toBe("Josh Tran");
});

it("press and hold, Make task, opens the new task", async () => {
  mockParams = { id: "dm_josh" };
  const Channel = require("@/app/chat/[id]").default;
  await wrap(<Channel />);
  const text = await screen.findByText(/cover the Marrickville stall/);
  const row = screen.getAllByTestId(/^chat-msg-/)[0];
  await fireEvent(row, "longPress");
  expect(text).toBeTruthy();
  await fireEvent.press(await screen.findByTestId("menu-make-task"));
  await waitFor(() => expect(mockPush).toHaveBeenCalledWith({ pathname: "/task/[id]", params: { id: expect.stringMatching(/^tsk_s/) } }));
  const { tasks } = await get<{ tasks: { title: string }[] }>("/tasks");
  expect(tasks.map((t) => t.title)).toContain("Can you cover the Marrickville stall from 7 on Saturday?");
});

it("thread shows the replies and sends one", async () => {
  const { messages } = await get<{ messages: { id: string; replyCount: number }[] }>("/chat/channels/chn_general/messages");
  const parent = messages.find((m) => m.replyCount > 0)!;
  mockParams = { id: parent.id };
  const Thread = require("@/app/chat/thread/[id]").default;
  await wrap(<Thread />);
  expect(await screen.findByText("2 replies")).toBeTruthy();
  expect(screen.getByText(/Payment matched/)).toBeTruthy();
  expect(screen.getByText("Agent")).toBeTruthy();
  await fireEvent.changeText(screen.getByTestId("thread-composer"), "Confirmed, mark it paid");
  await fireEvent.press(screen.getByTestId("thread-composer-send"));
  expect(await screen.findByText("Confirmed, mark it paid")).toBeTruthy();
  expect(screen.getByText("3 replies")).toBeTruthy();
});

it("a push for a reply opens the channel with the thread on top", async () => {
  const { messages } = await get<{ messages: { id: string; replyCount: number }[] }>("/chat/channels/chn_general/messages");
  const parent = messages.find((m) => m.replyCount > 0)!;
  const { replies } = await get<{ replies: { id: string }[] }>(`/chat/messages/${parent.id}/thread`);
  mockParams = { id: replies[0].id };
  const Link = require("@/app/chat/message/[id]").default;
  await wrap(<Link />);
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith({ pathname: "/chat/[id]", params: { id: "chn_general", thread: parent.id } }));
});

it("new message starts a DM with the picked people", async () => {
  const New = require("@/app/chat/new").default;
  await wrap(<New />);
  await fireEvent.press(await screen.findByTestId("pick-member:usr_priya"));
  expect(screen.queryByText("Invoice chaser")).toBeNull();
  await fireEvent.press(screen.getByTestId("start-dm"));
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith({ pathname: "/chat/[id]", params: { id: expect.stringMatching(/^dm_s/) } }));
});

it("notifications inbox (plain list, kept for servers before R31 triage): unread dots, filters, tap marks read and routes, mark all read", async () => {
  const Inbox = require("@/components/notifications-legacy").LegacyNotifications;
  await wrap(<Inbox />);
  expect(await screen.findByText("Josh Tran mentioned you in #general")).toBeTruthy();
  expect(screen.getByText("4 unread")).toBeTruthy();
  expect(screen.getByTestId("unread-dot-ntf_1")).toBeTruthy();
  expect(screen.queryByTestId("unread-dot-ntf_5")).toBeNull();
  for (const label of ["All", "Mentions", "Assigned", "Comments", "Approvals", "Due soon", "Chat"]) expect(screen.getAllByText(label).length).toBeGreaterThan(0);

  await fireEvent.press(screen.getByTestId("notification-ntf_3"));
  expect(mockPush).toHaveBeenCalledWith({ pathname: "/approval/[id]", params: { id: "apr_1" } });
  await waitFor(() => expect(screen.getByText("3 unread")).toBeTruthy());

  await fireEvent.press(screen.getByLabelText("Mentions, 2 unread"));
  await fireEvent.press(await screen.findByTestId("notification-ntf_1"));
  expect(screen.queryByText("Josh Tran sent you a message")).toBeNull();
  expect(mockPush).toHaveBeenCalledWith({ pathname: "/chat/message/[id]", params: { id: expect.stringMatching(/^cmsg_/) } });

  await fireEvent.press(screen.getByText("All"));
  await fireEvent.press(await screen.findByTestId("mark-all-read"));
  await waitFor(() => expect(screen.getByText("All caught up")).toBeTruthy());
  expect(screen.queryByTestId(/^unread-dot-/)).toBeNull();
});

it("notification settings show in app and push switches and save a change", async () => {
  const Settings = require("@/app/notification-settings").default;
  await wrap(<Settings />);
  expect(await screen.findByText("Mentions")).toBeTruthy();
  expect(screen.getByText("Due soon")).toBeTruthy();
  const sw = screen.getByTestId("push-comment");
  expect(sw.props.value).toBe(false);
  await act(async () => { fireEvent(sw, "valueChange", true); });
  await waitFor(async () => expect((await get<{ settings: Record<string, { push: boolean }> }>("/notifications/settings")).settings.comment.push).toBe(true));
});

it("settings link to the notifications inbox with its unread count, and to notification settings", async () => {
  const Settings = require("@/app/settings").default;
  await wrap(<Settings />);
  expect(await screen.findByLabelText("Notifications inbox, 4 unread")).toBeTruthy();
  await fireEvent.press(screen.getByTestId("notifications-link"));
  expect(mockPush).toHaveBeenCalledWith("/notifications");
  await fireEvent.press(screen.getByTestId("notification-settings-link"));
  expect(mockPush).toHaveBeenCalledWith("/notification-settings");
});
