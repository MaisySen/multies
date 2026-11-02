/**
 * 1.10.5: Social on the phone. Plain words for each network's reason, greyed out accounts that say why,
 * Reconnect where signing in again is the fix, and the screen against the sample workspace.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SessionProvider } from "@/lib/session";
import { SampleTransport } from "@/sample/transport";
import { filterPosts, laterOptions, postNote, socialErrorText, whyNot } from "@/lib/social";
import { sampleSocial } from "@/sample/social";
import { WEB_PAGES } from "@/config";

let mockParams: Record<string, string> = {};
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (cb: () => void) => { require("react").useEffect(cb, [cb]); },
  Stack: { Screen: () => null },
}));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }), SafeAreaView: ({ children }: { children: ReactNode }) => children }));

describe("social words", () => {
  it("shows the network's own reason and says when Reconnect is the fix", () => {
    expect(socialErrorText("rejected:Page token required")).toEqual({ code: "rejected", text: "The network turned the post down: \u201CPage token required\u201D", reconnect: false });
    expect(socialErrorText("no_permission").reconnect).toBe(true);
    expect(socialErrorText("not_finished").reconnect).toBe(true);
    expect(socialErrorText("reconnect").text).toMatch(/expired/);
    // A code from a newer server shows the network's words, not the generic line.
    expect(socialErrorText("new_code:Video too short").text).toBe("Video too short");
    expect(socialErrorText(null).text).toBe("The network turned the post down.");
  });

  it("greys out accounts that can't take the post and says why", () => {
    expect(whyNot({ app: "instagram", status: "active" }, "hi", false)).toMatch(/Needs an image/);
    expect(whyNot({ app: "instagram", status: "active" }, "hi", true)).toBeNull();
    expect(whyNot({ app: "twitter", status: "active" }, "x".repeat(300), false)).toMatch(/300 of 280/);
    expect(whyNot({ app: "linkedin", status: "expired" }, "hi", false)).toMatch(/Reconnect/);
    expect(whyNot({ app: "linkedin", status: "active" }, "hi", false, { accountId: "a", app: "linkedin", ok: false, code: "no_permission", text: null })).toMatch(/allowed posting/);
    expect(whyNot({ app: "linkedin", status: "active" }, "hi", false, { accountId: "a", app: "linkedin", ok: false, code: "check_failed", text: "x" })).toBeNull();
    expect(whyNot({ app: "youtube", status: "active" }, "hi", false)).toMatch(/not ready/);
    expect(postNote("linkedin", true)).toMatch(/leaves the image off/);
    expect(postNote("facebook", true)).toBeNull();
  });

  it("filters posts and offers later times in the future", () => {
    const { posts } = sampleSocial(Date.now());
    expect(filterPosts(posts, "failed").map((p) => p.id)).toEqual(["sp_2"]);
    expect(filterPosts(posts, "scheduled").map((p) => p.id)).toEqual(["sp_3"]);
    expect(filterPosts(posts, "sent").map((p) => p.id)).toEqual(["sp_2", "sp_1"]);
    const now = new Date();
    for (const o of laterOptions(now)) expect(o.at.getTime()).toBeGreaterThan(now.getTime());
  });

  it("opens the web's current Connections addresses", () => {
    expect(WEB_PAGES.connections).toMatch(/\/app\/settings\/apps\/mail$/);
    expect(WEB_PAGES.socialAccounts).toMatch(/\/app\/settings\/apps\/social$/);
  });
});

describe("Social screen", () => {
  let transport: SampleTransport;
  const wrap = async (ui: ReactNode) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={qc}><SessionProvider initialMode="sample" transportOverride={transport}>{ui}</SessionProvider></QueryClientProvider>);
  };
  beforeEach(() => { transport = new SampleTransport(); mockParams = {}; });

  it("lists posts with one compact row per network and Reconnect where that is the fix", async () => {
    // 1.10.6: the list shows a chip and one action per network; the full reason is on the post page (social-1106).
    const Social = require("@/app/social").default;
    await wrap(<Social />);
    expect(await screen.findByText("Partly posted")).toBeTruthy();
    expect(screen.getAllByText("Not posted").length).toBeGreaterThan(0);
    expect(screen.getByTestId("reconnect-row-linkedin")).toBeTruthy();
  });

  it("writes a post: greys out Instagram without an image and posts to Facebook and LinkedIn", async () => {
    mockParams = { tab: "new" };
    const Social = require("@/app/social").default;
    await wrap(<Social />);
    expect(await screen.findByTestId("why-instagram")).toHaveTextContent(/Reconnect/);
    expect(screen.getByTestId("reconnect-instagram")).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId("social-text"), "Fresh bread today");
    await fireEvent.press(screen.getByTestId("pick-facebook"));
    // Facebook needs a Page picked before Post works.
    expect(await screen.findByText("Harbour Bakery Events")).toBeTruthy();
    expect(screen.getByTestId("social-send")).toBeDisabled();
    await fireEvent.press(screen.getByText("Harbour Bakery Events"));
    await fireEvent.press(screen.getByTestId("pick-linkedin"));
    expect(screen.getByText("Post to 2")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("social-send"));
    // 1.10.6: the result screen opens and the composer is cleared, so going back never posts twice.
    const { router } = require("expo-router");
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(expect.stringMatching(/^\/social-posted\/sp_\d+$/)));
    expect(screen.getByTestId("social-text").props.value).toBe("");
  });

  it("accounts show health, TikTok test mode, Threads connected, and Connect for the rest", async () => {
    mockParams = { tab: "accounts" };
    const WebBrowser = require("expo-web-browser");
    const Social = require("@/app/social").default;
    await wrap(<Social />);
    expect(await screen.findByTestId("account-reconnect-instagram")).toBeTruthy();
    expect(await screen.findByText(/Test mode/)).toBeTruthy();
    expect(screen.getAllByText("@harbourbakery").length).toBe(2);
    expect(screen.getByTestId("connect-pinterest")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("direct-connect-tiktok"));
    await waitFor(() => expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith(WEB_PAGES.socialAccounts, expect.anything()));
  });
});
