/**
 * 1.10.8: the Social inbox and account health on the phone. Mock only: every request goes to the sample transport,
 * nothing reaches a server or a network.
 */
import { act, configure, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SessionProvider } from "@/lib/session";
import { SampleTransport } from "@/sample/transport";
import {
  assignChoices, canAssignTo, capLine, emptyInbox, fillSavedReply, filterCount, fmtLeft, inboxQuery, pinBroken, replyWindow, badgeText,
  type InboxSourceView,
} from "@/lib/social-inbox";
import { setOffline } from "@/lib/offline";
import { COMMANDS, createHandlers } from "@/lib/commands";
import { ApiError } from "@/api/errors";
import Social from "@/app/social";
import InboxItem from "@/app/social-inbox/[id]";
import { InboxTab } from "@/components/social-inbox";

let mockParams: Record<string, string> = {};
const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  router: { push: (...a: unknown[]) => mockPush(...a), back: jest.fn(), replace: jest.fn(), navigate: jest.fn() },
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (cb: () => void) => { require("react").useEffect(cb, [cb]); },
  Stack: { Screen: () => null },
}));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }), SafeAreaView: ({ children }: { children: ReactNode }) => children }));

// The box running these is shared and busy; give screens time to settle.
configure({ asyncUtilTimeout: 10_000 });
jest.setTimeout(60_000);

const NOW = Date.parse("2026-11-01T10:00:00Z");
const H = 3_600_000;

describe("reply window (24 h, Facebook and Instagram messages only)", () => {
  it("counts down in hours, then minutes, and warns in the last two hours", () => {
    const w = replyWindow("facebook", "message", new Date(NOW - 19 * H).toISOString(), NOW);
    expect(w).toMatchObject({ state: "open", text: "Reply window closes in 5 h", soon: false });
    const late = replyWindow("instagram", "message", new Date(NOW - 23.5 * H).toISOString(), NOW);
    expect(late).toMatchObject({ state: "open", text: "Reply window closes in 30 min", soon: true });
    expect(fmtLeft(10)).toBe("1 min");
    expect(fmtLeft(59 * 60_000)).toBe("59 min");
    expect(fmtLeft(61 * 60_000)).toBe("1 h");
  });
  it("closes at 24 hours and says what to do", () => {
    const w = replyWindow("facebook", "message", new Date(NOW - 24 * H).toISOString(), NOW);
    expect(w.state).toBe("closed");
    expect(w.state === "closed" && w.text).toMatch(/^Reply window closed\. Facebook only takes replies within 24 hours/);
  });
  it("has no window for comments, other networks or a missing time", () => {
    expect(replyWindow("facebook", "comment", new Date(NOW).toISOString(), NOW).state).toBe("none");
    expect(replyWindow("reddit", "message", new Date(NOW).toISOString(), NOW).state).toBe("none");
    expect(replyWindow("facebook", "message", null, NOW).state).toBe("none");
    expect(replyWindow("facebook", "message", "not a date", NOW).state).toBe("none");
  });
});

describe("assigning (the server's rule)", () => {
  const people = [{ id: "me", name: "Sam" }, { id: "ana", name: "Ana" }];
  it("members take an open conversation or let go of their own, nothing else", () => {
    expect(assignChoices({ assigneeId: null }, "me", false, people)).toEqual([{ id: "me", label: "Take it" }]);
    expect(assignChoices({ assigneeId: "me" }, "me", false, people)).toEqual([{ id: null, label: "Let go" }]);
    expect(assignChoices({ assigneeId: "ana" }, "me", false, people)).toEqual([]);
    expect(canAssignTo({ assigneeId: null }, "ana", "me", false)).toBe(false);
    expect(canAssignTo({ assigneeId: "ana" }, null, "me", false)).toBe(false);
    expect(canAssignTo({ assigneeId: "me" }, null, "me", false)).toBe(true);
  });
  it("owners and admins hand it to anyone, or to nobody", () => {
    expect(assignChoices({ assigneeId: "ana" }, "me", true, people)).toEqual([{ id: "me", label: "Sam (you)" }, { id: null, label: "Nobody" }]);
    expect(assignChoices({ assigneeId: null }, "me", true, people).map((c) => c.id)).toEqual(["me", "ana"]);
    expect(canAssignTo({ assigneeId: "ana" }, "me", "me", true)).toBe(true);
  });
});

describe("words and small rules", () => {
  it("asks the server for each filter and reads its count", () => {
    expect(inboxQuery("all")).toBe("?status=open");
    expect(inboxQuery("mine")).toBe("?status=open&view=mine");
    expect(inboxQuery("unassigned")).toBe("?status=open&view=unassigned");
    expect(inboxQuery("done")).toBe("?status=done");
    const c = { open: 5, mine: 1, unassigned: 3, done: 2 };
    expect([filterCount(c, "all"), filterCount(c, "mine"), filterCount(c, "unassigned"), filterCount(c, "done")]).toEqual([5, 1, 3, 2]);
    expect(filterCount(undefined, "all")).toBeUndefined();
  });
  it("fills saved replies with the first name, or drops it cleanly", () => {
    expect(fillSavedReply("Thanks {name}, glad you liked it!", "Priya Nair")).toBe("Thanks Priya, glad you liked it!");
    expect(fillSavedReply("Thanks {name}, glad you liked it!", null)).toBe("Thanks, glad you liked it!");
  });
  it("says posting only for networks that share nothing back", () => {
    expect(capLine("linkedin")).toBe("Posting only");
    expect(capLine("twitter")).toBe("Posting only");
    expect(capLine("facebook")).toBe("Posts, Comments, Messages, Analytics");
    expect(capLine("somethingnew")).toBe("Posting only");
  });
  it("pins broken accounts first and keeps the rest in order", () => {
    expect(pinBroken([1, 2, 3, 4], (n) => n % 2 === 0)).toEqual([2, 4, 1, 3]);
  });
  it("explains an empty inbox", () => {
    const src = (o: Partial<InboxSourceView>): InboxSourceView => ({ accountId: "a", app: "linkedin", label: "Sam", state: "posting_only", text: null, syncedAt: null, ...o });
    expect(emptyInbox("all", [src({})]).body).toMatch(/once their review of Multies is done/);
    expect(emptyInbox("all", [src({ state: "error", label: "@shop" })]).body).toMatch(/^@shop needs signing in again/);
    expect(emptyInbox("all", [src({ state: "ok" })]).body).toMatch(/Pull down to check again/);
    expect(emptyInbox("done", []).title).toBe("Nothing done yet");
  });
  it("caps the badge", () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(undefined)).toBeNull();
    expect(badgeText(7)).toBe("7");
    expect(badgeText(150)).toBe("99+");
  });
  it("has no dashes in the new words", () => {
    const words = [emptyInbox("all", []).body, emptyInbox("mine", []).body, replyWindow("facebook", "message", new Date(NOW - 30 * H).toISOString(), NOW)];
    expect(JSON.stringify(words)).not.toMatch(/[\u2013\u2014]/);
  });
  it("has a Social inbox command that opens the Inbox part", () => {
    expect(COMMANDS.find((c) => c.id === "social-inbox")?.title).toBe("Social inbox");
    const navigate = jest.fn();
    const h = createHandlers({ navigate } as never) as Record<string, () => void>;
    h["social-inbox"]!();
    expect(navigate).toHaveBeenCalledWith({ pathname: "/social", params: { tab: "inbox" } });
  });
});

/* ---------------------------------------------------------------- screens, on the sample workspace */

async function wrap(ui: ReactNode, transport = new SampleTransport()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  return { qc, transport, view: await render(<QueryClientProvider client={qc}><SessionProvider initialMode="sample" transportOverride={transport}>{ui}</SessionProvider></QueryClientProvider>) };
}

describe("Social screen, Inbox part", () => {
  beforeEach(() => { mockParams = { tab: "inbox" }; mockPush.mockClear(); setOffline(false); });

  it("lists open conversations with filters, counts and hints", async () => {
    await wrap(<Social />);
    await screen.findByTestId("inbox-row-si_1");
    expect(screen.getByTestId("inbox-filter-all").props.accessibilityLabel).toBe("Open, 5");
    expect(screen.getByTestId("inbox-filter-done").props.accessibilityLabel).toBe("Done, 1");
    expect(screen.queryByTestId("inbox-row-si_6")).toBeNull();
    expect(screen.getByText("Reply window closed")).toBeTruthy();
    expect(screen.getByTestId("inbox-broken")).toBeTruthy();
    expect(screen.getByTestId("inbox-row-si_3").props.accessibilityLabel).toMatch(/Reply window closes in \d+ min/);
  });

  it("switches filters (Mine, Done)", async () => {
    await wrap(<Social />);
    await screen.findByTestId("inbox-row-si_1");
    await fireEvent.press(screen.getByTestId("inbox-filter-mine"));
    await screen.findByTestId("inbox-row-si_3");
    await waitFor(() => expect(screen.queryByTestId("inbox-row-si_1")).toBeNull());
    await fireEvent.press(screen.getByTestId("inbox-filter-done"));
    await screen.findByTestId("inbox-row-si_6");
  });

  it("opens a conversation on tap", async () => {
    await wrap(<Social />);
    await fireEvent.press(await screen.findByTestId("inbox-row-si_2"));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/social-inbox/[id]", params: { id: "si_2" } });
  });

  it("broken accounts banner opens Accounts, where broken ones sit first with Reconnect and capabilities", async () => {
    await wrap(<Social />);
    await fireEvent.press(await screen.findByTestId("inbox-open-accounts"));
    await screen.findByTestId("social-accounts");
    const rows = screen.getAllByTestId(/^account-(facebook|linkedin|instagram)$/).map((r) => r.props.testID);
    expect(rows[0]).toBe("account-instagram");
    expect(screen.getByTestId("account-reconnect-instagram")).toBeTruthy();
    expect(screen.getByTestId("account-caps-linkedin").props.children).toBe("Posting only");
  });

  it("hides the Inbox part where the server has no inbox", async () => {
    const t = new SampleTransport();
    const orig = t.request.bind(t);
    t.request = (async (method: string, path: string, ...rest: unknown[]) => {
      if (path.startsWith("/social/inbox")) throw new ApiError(404, "not_found", "Not found.");
      return (orig as (...a: unknown[]) => Promise<unknown>)(method, path, ...rest);
    }) as typeof t.request;
    await wrap(<Social />, t);
    await screen.findByTestId("social-posts");
    expect(screen.queryByText("Inbox")).toBeNull();
    expect(screen.queryByTestId("inbox-filters")).toBeNull();
  });

  it("shows the error with Try again", async () => {
    const t = new SampleTransport();
    const orig = t.request.bind(t);
    t.request = (async (method: string, path: string, ...rest: unknown[]) => {
      if (path.startsWith("/social/inbox")) throw new ApiError(500, "server", "Something went wrong on our side.");
      return (orig as (...a: unknown[]) => Promise<unknown>)(method, path, ...rest);
    }) as typeof t.request;
    await wrap(<Social />, t);
    await screen.findByTestId("inbox-error", {}, { timeout: 4000 });
    expect(screen.getByTestId("inbox-try-again")).toBeTruthy();
  });

  it("says when it is offline", async () => {
    await wrap(<Social />);
    await screen.findByTestId("inbox-row-si_1");
    await act(async () => setOffline(true));
    await screen.findByText(/You're offline\. Showing what loaded last/);
    await act(async () => setOffline(false));
  });
});

describe("Conversation screen", () => {
  beforeEach(() => { mockParams = { id: "si_1" }; setOffline(false); });

  async function open(id: string) {
    mockParams = { id };
    const Item = InboxItem;
    const t = new SampleTransport();
    // The list loads first (as on the phone), so the screen knows who I am and the people.
    const out = await wrap(<><InboxTab filter="all" onAccounts={() => {}} /><Item /></>, t);
    await screen.findByTestId("inbox-item-message");
    await screen.findByTestId("inbox-row-si_1");
    return out;
  }

  it("shows the message, the window hint, and takes a reply", async () => {
    await open("si_1");
    expect(screen.getByText(/Reply window closes in \d+ h\. Facebook only takes replies/)).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId("inbox-input"), "Yes, two rye loaves saved for you.");
    await fireEvent.press(screen.getByTestId("inbox-send"));
    await screen.findByText("Yes, two rye loaves saved for you.");
    expect(screen.getByText("Sam Lee replied")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("inbox-assignee").props.children).toBe("You"));
  });

  it("adds a note", async () => {
    await open("si_1");
    await fireEvent.press(screen.getByText("Note"));
    await fireEvent.changeText(screen.getByTestId("inbox-input"), "Call her back about pick up.");
    await fireEvent.press(screen.getByTestId("inbox-send"));
    await screen.findByText("Note from Sam Lee");
  });

  it("fills a saved reply with the first name", async () => {
    await open("si_1");
    await fireEvent.press(await screen.findByTestId("inbox-saved-sr_1"));
    expect(screen.getByTestId("inbox-input").props.value).toBe("Thanks Priya, glad you liked it!");
  });

  it("closed window: no Reply, notes only, with what to do", async () => {
    await open("si_5");
    expect(screen.getByTestId("inbox-window-closed")).toBeTruthy();
    expect(screen.queryByText("Reply")).toBeNull();
    expect(screen.getByTestId("inbox-input").props.placeholder).toBe("Note for your team");
  });

  it("assigns (admin sees everyone) and marks done with Undo", async () => {
    await open("si_2");
    expect(screen.getByTestId("inbox-assignee").props.children).toBe("Ana Ruiz");
    await fireEvent.press(screen.getByTestId("inbox-assign-u_sam"));
    await waitFor(() => expect(screen.getByTestId("inbox-assignee").props.children).toBe("You"));
    await fireEvent.press(screen.getByTestId("inbox-done"));
    await screen.findByTestId("inbox-undo-bar");
    await fireEvent.press(screen.getByTestId("inbox-undo"));
    await screen.findByTestId("inbox-done");
  });

  it("makes a task once, then opens it", async () => {
    await open("si_4");
    await fireEvent.press(screen.getByTestId("inbox-make-task"));
    await screen.findByTestId("inbox-open-task");
  });

  it("offline: send and actions wait", async () => {
    await open("si_1");
    await act(async () => setOffline(true));
    await screen.findByText(/You're offline\. Replies and notes send when you're back/);
    await fireEvent.changeText(screen.getByTestId("inbox-input"), "hello");
    expect(screen.getByTestId("inbox-send").props.accessibilityState?.disabled).toBe(true);
    await act(async () => setOffline(false));
  });
});
