/**
 * R36: the phone keeps to the server's ugc contract (R35 report and block).
 * - A blocked DM is 403 {"error":{"code":"blocked","message":"You can't message this person."}}: every send path
 *   (a new DM, a text message, a message with files) shows exactly "You can't message this person.".
 * - DELETE /blocks/:userId answering 404 means there was no block: it counts as done, the person ends up
 *   not blocked and no error shows.
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SessionProvider } from "@/lib/session";
import { SampleTransport } from "@/sample/transport";
import { ApiError, toApiError } from "@/api/errors";
import type { Method, RequestOptions } from "@/api/transport";
import { BLOCKED_TEXT, dmErrorText, isBlockedError, isUnblockDone } from "@/lib/moderation";
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
const BLOCKED_BODY = { error: { code: "blocked", message: "You can't message this person." } };

describe("the contract, as plain rules", () => {
  it("reads the server's 403 blocked body as blocked, and every send path says the same line", () => {
    const e = toApiError(403, BLOCKED_BODY);
    expect(e.status).toBe(403);
    expect(e.code).toBe("blocked");
    expect(isBlockedError(e)).toBe(true);
    expect(BLOCKED_TEXT).toBe("You can't message this person.");
    expect(sendErrorText(e)).toBe(BLOCKED_TEXT);
    expect(dmErrorText(e)).toBe(BLOCKED_TEXT);
  });
  it("a different 403 is not a block", () => {
    const e = toApiError(403, { error: { code: "forbidden", message: "Not in this workspace." } });
    expect(isBlockedError(e)).toBe(false);
    expect(sendErrorText(e)).toBe("Not in this workspace.");
    expect(dmErrorText(e)).toBe("Not in this workspace.");
    expect(isBlockedError(new ApiError(400, "blocked", "x"))).toBe(false);
  });
  it("unblock: 404 is done, anything else is a real failure", () => {
    expect(isUnblockDone(toApiError(404, { error: { code: "not_found", message: "Not found" } }))).toBe(true);
    expect(isUnblockDone(toApiError(500, {}))).toBe(false);
    expect(isUnblockDone(toApiError(403, BLOCKED_BODY))).toBe(false);
    expect(isUnblockDone(new Error("boom"))).toBe(false);
  });
});

/** The other person blocked me: the server refuses new DMs and messages to them. */
class BlockedByThem extends SampleTransport {
  async request<T>(method: Method, path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    if (method === "POST" && (path === "/chat/dms" || (path.startsWith("/chat/channels/dm_") && path.endsWith("/messages")))) throw toApiError(403, BLOCKED_BODY);
    return super.request<T>(method, path, body, opts);
  }
}

/** The block was already gone (removed on another device): DELETE answers 404. */
class AlreadyUnblocked extends SampleTransport {
  async request<T>(method: Method, path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    if (method === "DELETE" && path.startsWith("/blocks/")) {
      await super.request(method, path, body, opts).catch(() => undefined);
      throw toApiError(404, { error: { code: "not_found", message: "Not found" } });
    }
    return super.request<T>(method, path, body, opts);
  }
}

let transport: SampleTransport;
const clients: QueryClient[] = [];
async function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  clients.push(qc);
  return render(<QueryClientProvider client={qc}><SessionProvider initialMode="sample" transportOverride={transport}>{ui}</SessionProvider></QueryClientProvider>);
}
afterEach(() => { while (clients.length) clients.pop()!.clear(); });
beforeEach(() => { mockPush.mockClear(); mockParams = {}; });

it("starting a DM with someone who blocked me shows the blocked line", async () => {
  transport = new BlockedByThem();
  const NewDm = require("@/app/chat/new").default;
  await wrap(<NewDm />);
  const pick = await screen.findByTestId("pick-member:usr_josh", {}, LONG);
  await act(async () => { await fireEvent.press(pick); });
  await act(async () => { await fireEvent.press(screen.getByTestId("start-dm")); });
  expect(await screen.findByText(BLOCKED_TEXT, {}, LONG)).toBeTruthy();
});

it("sending in a DM after they blocked me shows the same line in the composer", async () => {
  transport = new BlockedByThem();
  mockParams = { id: "dm_josh" };
  const Dm = require("@/app/chat/[id]").default;
  await wrap(<Dm />);
  const box = await screen.findByTestId("composer", {}, LONG);
  await act(async () => { await fireEvent.changeText(box, "Are we still on for Saturday?"); });
  await act(async () => { await fireEvent.press(screen.getByTestId("composer-send")); });
  expect(await screen.findByText(BLOCKED_TEXT, {}, LONG)).toBeTruthy();
});

it("unblock that answers 404 counts as done: the person leaves the list and no error shows", async () => {
  transport = new AlreadyUnblocked();
  await transport.request("POST", "/blocks", { userId: "usr_josh" });
  const Blocked = require("@/app/blocked").default;
  await wrap(<Blocked />);
  expect(await screen.findByText("Josh Tran", {}, LONG)).toBeTruthy();
  await act(async () => { await fireEvent.press(screen.getByLabelText("Unblock Josh Tran")); });
  expect(await screen.findByText("No one is blocked", {}, LONG)).toBeTruthy();
  expect(screen.queryByText(/didn't work|Couldn't|went wrong/i)).toBeNull();
});
