/**
 * PRIV1b (MH4): the wiring that keeps offline data in its place. The Search screen hands the overview's mailboxes to
 * the offline search, and the queue runner hands the current workspace to the command queue.
 */
import { act, configure, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SessionProvider } from "@/lib/session";
import { SampleTransport } from "@/sample/transport";
import { endpoints } from "@/api/endpoints";
import { kv } from "@/lib/kv";
import { ApiError } from "@/api/errors";
import { searchCache, setOffline } from "@/lib/offline";
import { commandQueue, QUEUE_KEY } from "@/lib/command-queue";
import { useCommandQueueRunner } from "@/components/sync-pill";
import Search from "@/app/search";

jest.mock("expo-router", () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), navigate: jest.fn() },
  useLocalSearchParams: () => ({}),
  useFocusEffect: (cb: () => void) => { require("react").useEffect(cb, [cb]); },
  Stack: { Screen: () => null },
}));
jest.mock("@/lib/offline", () => ({ ...jest.requireActual("@/lib/offline"), searchCache: jest.fn(async () => []) }));

configure({ asyncUtilTimeout: 10_000 });
jest.setTimeout(30_000);

function withSession(t: SampleTransport) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) { return <QueryClientProvider client={qc}><SessionProvider transportOverride={t}>{children}</SessionProvider></QueryClientProvider>; };
}

afterEach(() => setOffline(false));

describe("PRIV1b MH4: Search passes the overview's mailboxes to the offline search", () => {
  it("searches saved mail only in the mailboxes of the overview", async () => {
    // No connection: every call fails, the overview comes from the phone.
    const s = new SampleTransport();
    const t = { kind: "sample" as const, request: async (m: never, p: string, b?: unknown, o?: never) => {
      if (p.startsWith("/account/me")) return s.request(m, p, b, o);
      throw new ApiError(0, "network", "offline");
    } } as unknown as SampleTransport;
    await kv().clear();
    await kv().set("meta:live:overview", JSON.stringify({ at: 1, v: { mailboxes: [{ id: "mb_team" }, { id: "mb_shared" }] } }));
    const Wrapper = withSession(t);
    await render(<Wrapper><Search /></Wrapper>);
    await fireEvent.changeText(await screen.findByTestId("search"), "invoice");
    await waitFor(() => expect(jest.mocked(searchCache)).toHaveBeenCalledWith(expect.anything(), "invoice", ["mb_team", "mb_shared"]));
  });
});

describe("PRIV1b MH4: the queue runner passes the current workspace", () => {
  it("a change queued through the app's queue records the signed in workspace", async () => {
    await kv().clear();
    const t = new SampleTransport();
    const org = (await endpoints(t).me()).organization!.id;
    setOffline(true);
    await renderHook(() => useCommandQueueRunner(), { wrapper: withSession(t) });
    await waitFor(() => expect(commandQueue()).not.toBeNull());
    await act(async () => { await commandQueue()!.enqueue({ kind: "mail.action", messageId: "m1", action: "archive" }); });
    expect(JSON.parse((await kv().get(QUEUE_KEY))!)[0].ws).toBe(org);
  });
});
