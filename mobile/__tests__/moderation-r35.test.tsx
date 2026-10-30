/**
 * R35: report and block (App Store guideline 1.2). Unit tests for the pure rules, then the flows
 * against the sample workspace: report a message, block from the menu (messages vanish, one quiet
 * row shows), the blocked people list with Unblock, and a server without the endpoints (404).
 */
import { Alert } from "react-native";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SessionProvider } from "@/lib/session";
import { SampleTransport } from "@/sample/transport";
import { ApiError } from "@/api/errors";
import type { Method, RequestOptions } from "@/api/transport";
import {
  blockConfirm, blockedIds, canBlockAuthor, dropEvent, filterBlocked, HIDDEN_ROW, isBlockedError, isMissingEndpoint, NOTE_MAX, REPORT_FAILED, REPORT_REASONS,
  REPORT_THANKS, reportBody, reportErrorText, userIdOf, withBlock, withoutBlock,
} from "@/lib/moderation";
import { sendErrorText } from "@/lib/chat-files";

const mockPush = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock("expo-router", () => ({
  router: { push: (...a: unknown[]) => mockPush(...a), back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => mockParams,
  useIsFocused: () => true,
  Stack: { Screen: () => null },
}));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }), SafeAreaView: ({ children }: { children: ReactNode }) => children }));

const LONG = { timeout: 10_000 };
jest.setTimeout(60_000);
const msg = (authorId: string, type: "member" | "agent" | "guest" = "member") => ({ author: { id: authorId, type, name: authorId } });

describe("moderation rules", () => {
  it("reads the user id from either chat id form", () => {
    expect(userIdOf("member:usr_1")).toBe("usr_1");
    expect(userIdOf("guest:usr_2")).toBe("usr_2");
    expect(userIdOf("usr_3")).toBe("usr_3");
    expect(userIdOf(null)).toBe("");
  });

  it("filters blocked people's messages, never agents, and says something was hidden without a count", () => {
    const blocked = blockedIds([{ userId: "usr_b", name: "B", avatarUrl: null, createdAt: "" }]);
    const list = [msg("member:usr_a"), msg("member:usr_b"), msg("usr_b"), msg("usr_b", "agent")];
    const r = filterBlocked(list, blocked);
    expect(r.messages).toEqual([list[0], list[3]]);
    expect(r.hidden).toBe(true);
    expect(filterBlocked(list, new Set()).hidden).toBe(false);
    expect(filterBlocked([msg("member:usr_a")], blocked)).toEqual({ messages: [msg("member:usr_a")], hidden: false });
  });

  it("drops realtime events from blocked people", () => {
    const blocked = new Set(["usr_b"]);
    expect(dropEvent({ authorId: "member:usr_b" }, blocked)).toBe(true);
    expect(dropEvent({ author: { id: "usr_b" } }, blocked)).toBe(true);
    expect(dropEvent({ authorId: "member:usr_a" }, blocked)).toBe(false);
    expect(dropEvent({}, blocked)).toBe(false);
  });

  it("only real people other than you can be blocked", () => {
    expect(canBlockAuthor(msg("member:usr_a"), "member:usr_me")).toBe(true);
    expect(canBlockAuthor(msg("member:usr_me"), "member:usr_me")).toBe(false);
    expect(canBlockAuthor(msg("agt_1", "agent"), "member:usr_me")).toBe(false);
  });

  it("builds the report body within the contract", () => {
    expect(reportBody({ targetType: "message", messageId: "m1", userId: "u1", context: "chat", reason: "spam", note: "  hi  " }))
      .toEqual({ targetType: "message", messageId: "m1", userId: "u1", context: "chat", reason: "spam", note: "hi" });
    expect(reportBody({ targetType: "user", messageId: "m1", userId: "u1", reason: "other", note: "   " })).toEqual({ targetType: "user", userId: "u1", reason: "other" });
    expect(reportBody({ targetType: "user", userId: "u1", reason: "other", note: "x".repeat(900) }).note).toHaveLength(NOTE_MAX);
    expect(REPORT_REASONS.map((r) => r.id)).toEqual(["spam", "harassment", "hate", "sexual", "violence", "self_harm", "other"]);
  });

  it("words: the confirm names the person, errors stay plain", () => {
    expect(blockConfirm("Sam Lee")).toEqual({ title: "Block Sam Lee?", body: "You won't see their messages and they can't message you. They won't be told.", action: "Block" });
    expect(reportErrorText(new ApiError(404, "not_found", "x"))).toBe(REPORT_FAILED);
    expect(reportErrorText(new ApiError(429, "too_many_requests", "x"))).toMatch(/Try again tomorrow/);
    expect(isMissingEndpoint(new ApiError(404, "not_found", "x"))).toBe(true);
    expect(isMissingEndpoint(new ApiError(500, "error", "x"))).toBe(false);
    const blocked = new ApiError(403, "blocked", "You can't message this person.");
    expect(isBlockedError(blocked)).toBe(true);
    expect(sendErrorText(blocked)).toBe("You can't message this person.");
  });

  it("keeps the cached list without duplicates", () => {
    const one = withBlock([], { userId: "u1", name: "A" }, new Date(0));
    expect(withBlock(one, { userId: "u1", name: "A" })).toBe(one);
    expect(withoutBlock(one, "u1")).toEqual([]);
  });
});

// ---------------------------------------------------------------- flows on the sample workspace

/** A server without the R35 endpoints yet: /blocks and /reports answer 404. */
class OldServer extends SampleTransport {
  async request<T>(method: Method, path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    if (path.startsWith("/blocks") || path.startsWith("/reports")) throw new ApiError(404, "not_found", "Not found");
    return super.request<T>(method, path, body, opts);
  }
}

let transport: SampleTransport;
const clients: QueryClient[] = [];
async function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(qc);
  return render(<QueryClientProvider client={qc}><SessionProvider initialMode="sample" transportOverride={transport}>{ui}</SessionProvider></QueryClientProvider>);
}
const spies: { mockRestore: () => void }[] = [];
afterEach(() => { while (clients.length) clients.pop()!.clear(); while (spies.length) spies.pop()!.mockRestore(); });
beforeEach(() => { transport = new SampleTransport(); mockPush.mockClear(); mockParams = {}; });

async function someoneElsesMessage() {
  const { messages } = await transport.request<{ messages: { id: string; body: string; author: { id: string; type: string; name: string } }[] }>("GET", "/chat/channels/chn_general/messages");
  const m = messages.find((x) => x.author.type === "member" && !x.author.id.endsWith("usr_sample"));
  if (!m) throw new Error("no message from another member in the sample");
  return { m, all: messages };
}

it("long press, Report message, pick a reason, Send: thanks line and Also block", async () => {
  const { m } = await someoneElsesMessage();
  mockParams = { id: "chn_general" };
  const spy = jest.spyOn(transport, "request");
  spies.push(spy);
  const Channel = require("@/app/chat/[id]").default;
  await wrap(<Channel />);
  await screen.findByTestId(`chat-msg-${m.id}`, {}, LONG);
  await act(async () => { await fireEvent(screen.getByTestId(`chat-msg-${m.id}`), "longPress"); });
  expect(screen.getByText(`Block ${m.author.name}`)).toBeTruthy();
  await act(async () => { await fireEvent.press(screen.getByTestId("menu-report")); });
  expect(await screen.findByTestId("report-sheet", {}, LONG)).toBeTruthy();
  await act(async () => { await fireEvent.press(screen.getByTestId("report-reason-harassment")); });
  await act(async () => { await fireEvent.changeText(screen.getByTestId("report-note"), "  keeps sending this  "); });
  await act(async () => { await fireEvent.press(screen.getByTestId("report-send")); });
  expect(await screen.findByText(REPORT_THANKS, {}, LONG)).toBeTruthy();
  expect(screen.getByText(`Also block ${m.author.name}`)).toBeTruthy();
  const call = spy.mock.calls.find((c) => c[1] === "/reports");
  expect(call?.[0]).toBe("POST");
  expect(call?.[2]).toEqual({ targetType: "message", messageId: m.id, userId: userIdOf(m.author.id), context: "chat", reason: "harassment", note: "keeps sending this" });
});

it("Block from the menu: confirm names the person, their messages vanish, one quiet row shows", async () => {
  const { m, all } = await someoneElsesMessage();
  const theirs = all.filter((x) => userIdOf(x.author.id) === userIdOf(m.author.id));
  mockParams = { id: "chn_general" };
  const alert = jest.spyOn(Alert, "alert").mockImplementation((_t, _b, buttons) => { buttons?.find((b) => b.style === "destructive")?.onPress?.(); });
  spies.push(alert);
  const Channel = require("@/app/chat/[id]").default;
  await wrap(<Channel />);
  await screen.findByTestId(`chat-msg-${m.id}`, {}, LONG);
  await act(async () => { await fireEvent(screen.getByTestId(`chat-msg-${m.id}`), "longPress"); });
  await act(async () => { await fireEvent.press(screen.getByTestId("menu-block")); });
  expect(alert).toHaveBeenCalledWith(`Block ${m.author.name}?`, "You won't see their messages and they can't message you. They won't be told.", expect.any(Array));
  await waitFor(() => expect(screen.queryByTestId(`chat-msg-${m.id}`)).toBeNull(), LONG);
  for (const x of theirs) expect(screen.queryByTestId(`chat-msg-${x.id}`)).toBeNull();
  expect(screen.getAllByText(HIDDEN_ROW)).toHaveLength(1);
  const { blocks } = await transport.request<{ blocks: { userId: string }[] }>("GET", "/blocks");
  expect(blocks.map((b) => b.userId)).toEqual([userIdOf(m.author.id)]);
});

it("Blocked people lists who you blocked and Unblock takes them off", async () => {
  await transport.request("POST", "/blocks", { userId: "usr_josh" });
  const Blocked = require("@/app/blocked").default;
  await wrap(<Blocked />);
  expect(await screen.findByText("Josh Tran", {}, LONG)).toBeTruthy();
  await act(async () => { await fireEvent.press(screen.getByLabelText("Unblock Josh Tran")); });
  expect(await screen.findByText("No one is blocked", {}, LONG)).toBeTruthy();
  const { blocks } = await transport.request<{ blocks: unknown[] }>("GET", "/blocks");
  expect(blocks).toEqual([]);
});

it("a server without the endpoints: menus still show, nothing breaks, Report says Couldn't send", async () => {
  transport = new OldServer();
  const { m } = await someoneElsesMessage();
  mockParams = { id: "chn_general" };
  const Channel = require("@/app/chat/[id]").default;
  await wrap(<Channel />);
  await screen.findByTestId(`chat-msg-${m.id}`, {}, LONG);
  expect(screen.queryByText(HIDDEN_ROW)).toBeNull();
  await act(async () => { await fireEvent(screen.getByTestId(`chat-msg-${m.id}`), "longPress"); });
  expect(screen.getByTestId("menu-block")).toBeTruthy();
  await act(async () => { await fireEvent.press(screen.getByTestId("menu-report")); });
  await act(async () => { await fireEvent.press(screen.getByTestId("report-reason-spam")); });
  await act(async () => { await fireEvent.press(screen.getByTestId("report-send")); });
  expect(await screen.findByText(REPORT_FAILED, {}, LONG)).toBeTruthy();
});
