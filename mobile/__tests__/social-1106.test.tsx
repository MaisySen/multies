/**
 * 1.10.6: Social, planned and checked. Nothing slides under the header (fixed header, pinned bar, one list with its
 * own insets), a clear result after Post now, the posts on screen checked with Facebook, Delete that also deletes on
 * Facebook and LinkedIn, and the removed state. Words match the web.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { SessionProvider } from "@/lib/session";
import { SampleTransport } from "@/sample/transport";
import { sampleSocial } from "@/sample/social";
import {
  deleteConfirm, deleteMessage, healthChip, imageDropNote, mergePosts, needsDeleteNote, postBadge, resultTitle, socialSummary, syncIds, targetChip,
  LINKEDIN_DELETE_NOTE, type PostTargetView, type SocialPostView,
} from "@/lib/social";
import { keyboardOverlap } from "@/components/social";
import { clearSocialToast, currentSocialToast } from "@/lib/social-queries";
import { setOffline } from "@/lib/offline";
import { COMMANDS, createHandlers } from "@/lib/commands";

let mockParams: Record<string, string> = {};
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), navigate: jest.fn() },
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (cb: () => void) => { require("react").useEffect(cb, [cb]); },
  Stack: { Screen: () => null },
}));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }), SafeAreaView: ({ children }: { children: ReactNode }) => children }));

const NOW = Date.parse("2026-10-31T10:00:00Z");
const target = (o: Partial<PostTargetView>): PostTargetView => ({
  accountId: "a", app: "facebook", label: "Fintex", target: "pg", targetName: "Fintex", status: "sent", url: "https://www.facebook.com/1/posts/2", error: null,
  sentAt: new Date(NOW - 3600_000).toISOString(), networkState: "live", checkedAt: null, canCheck: true, canDelete: true, ...o,
});
const fb = (o: Partial<PostTargetView> = {}) => target(o);
const li = (o: Partial<PostTargetView> = {}) => target({ accountId: "b", app: "linkedin", label: "Bidur", target: null, targetName: null, url: "https://www.linkedin.com/feed/update/x", networkState: null, canCheck: false, ...o });
const ig = (o: Partial<PostTargetView> = {}) => target({ accountId: "c", app: "instagram", label: "@fintex", target: null, targetName: null, networkState: null, canCheck: false, canDelete: false, ...o });
const post = (targets: PostTargetView[], o: Partial<SocialPostView> = {}): SocialPostView => ({
  id: "p1", text: "Testing. https://fintex.au", imageUrl: null, status: "done", runAt: new Date(NOW - 3600_000).toISOString(), createdAt: new Date(NOW - 3600_000).toISOString(), createdBy: "Bidur", targets, ...o,
});

describe("1.10.6 rules", () => {
  it("checks only Facebook posts sent in the last 30 days and not removed, at most 20", () => {
    const old = post([fb({ sentAt: new Date(NOW - 31 * 86400_000).toISOString() })], { id: "old" });
    const gone = post([fb({ networkState: "removed", url: null })], { id: "gone" });
    const liOnly = post([li()], { id: "li" });
    const failed = post([fb({ status: "failed", url: null, sentAt: null })], { id: "failed", status: "failed" });
    const fresh = Array.from({ length: 25 }, (_, i) => post([fb(), li()], { id: `f${i}` }));
    expect(syncIds([old, gone, liOnly, failed], NOW)).toEqual([]);
    expect(syncIds(fresh, NOW)).toHaveLength(20);
    expect(syncIds([post([fb()], { id: "x" })], NOW)).toEqual(["x"]);
    expect(syncIds(undefined, NOW)).toEqual([]);
  });

  it("puts fresher posts in place and keeps the order", () => {
    const a = post([fb()], { id: "a" }), b = post([fb()], { id: "b" });
    const b2 = { ...b, targets: [fb({ networkState: "removed", url: null })] };
    expect(mergePosts([a, b], [b2]).map((p) => [p.id, p.targets[0]!.networkState])).toEqual([["a", "live"], ["b", "removed"]]);
  });

  it("says the result in the web's words", () => {
    expect(resultTitle(post([fb()]), NOW)).toBe("Posted to Facebook");
    expect(resultTitle(post([fb(), li()]), NOW)).toBe("Posted to all 2 accounts");
    expect(resultTitle(post([fb(), li({ status: "failed", url: null, error: "no_permission" })], { status: "partial" }), NOW)).toBe("Posted to 1 of 2 accounts");
    expect(resultTitle(post([fb({ status: "failed" })], { status: "failed" }), NOW)).toBe("Not posted");
    expect(resultTitle(post([fb({ status: "pending", sentAt: null })], { status: "scheduled", runAt: new Date(NOW).toISOString() }), NOW)).toBe("Posting now");
    expect(resultTitle(post([fb({ status: "pending", sentAt: null })], { status: "scheduled", runAt: new Date(NOW + 86400_000).toISOString() }), NOW)).toBe("Scheduled");
  });

  it("shows a Facebook delete as Removed on Facebook and gives LinkedIn the quiet note", () => {
    expect(targetChip(fb({ networkState: "removed", url: null })).label).toBe("Removed on Facebook");
    expect(targetChip(li()).label).toBe("Posted");
    expect(targetChip(li({ status: "failed" })).label).toBe("Not posted");
    expect(needsDeleteNote(li())).toBe(true);
    expect(needsDeleteNote(fb())).toBe(false);
    expect(LINKEDIN_DELETE_NOTE).toBe("LinkedIn doesn't tell Multies when a post is deleted there. Deleted it on LinkedIn? Delete it here too.");
    expect(postBadge(post([fb({ networkState: "removed" })])).label).toBe("Removed");
    expect(postBadge(post([fb({ networkState: "removed" }), li()])).label).toBe("Posted");
  });

  it("works with a server from before (no networkState, canCheck or canDelete)", () => {
    const bare = { ...fb(), networkState: undefined, canCheck: undefined, canDelete: undefined, checkedAt: undefined };
    expect(targetChip(bare).label).toBe("Posted");
    expect(needsDeleteNote(bare)).toBe(false);
    expect(syncIds([post([bare])], NOW)).toEqual([]);
    expect(deleteConfirm(post([bare])).body).toBe("It leaves your list in Multies. It stays on Facebook. Delete it there yourself. You can't undo this.");
  });

  it("names exactly where a delete goes", () => {
    expect(deleteConfirm(post([fb(), li()]))).toEqual({ title: "Delete this post?", body: "It will also be deleted from Facebook and LinkedIn. You can't undo this.", button: "Delete from Facebook and LinkedIn" });
    // Facebook already removed it: only LinkedIn is named.
    expect(deleteConfirm(post([fb({ networkState: "removed", url: null }), li()])).button).toBe("Delete from LinkedIn");
    expect(deleteConfirm(post([fb(), ig()])).body).toBe("It will also be deleted from Facebook. It stays on Instagram. Delete it there yourself. You can't undo this.");
    expect(deleteConfirm(post([fb({ status: "pending", sentAt: null })], { status: "scheduled" })).button).toBe("Delete post");
  });

  it("says what a delete did", () => {
    expect(deleteMessage({ deleted: true, post: null, results: [{ accountId: "a", app: "facebook", outcome: "deleted" }, { accountId: "b", app: "linkedin", outcome: "already_gone" }] }))
      .toEqual({ ok: true, text: "Post deleted from Facebook and LinkedIn" });
    expect(deleteMessage({ deleted: false, post: null, results: [{ accountId: "a", app: "facebook", outcome: "deleted" }, { accountId: "b", app: "linkedin", outcome: "failed" }] }))
      .toEqual({ ok: false, text: "Deleted from Facebook. LinkedIn didn't delete it. Try again in a minute." });
    expect(deleteMessage({ deleted: true, post: null, results: [] }).text).toBe("Post deleted");
  });

  it("notes a dropped image, the Today summary and the account chips", () => {
    expect(imageDropNote(post([fb(), li()], { imageUrl: "https://x/i.png" }))).toBe("LinkedIn posted the text only. It doesn't take images from Multies yet.");
    expect(imageDropNote(post([fb()], { imageUrl: "https://x/i.png" }))).toBeNull();
    expect(socialSummary([post([fb(), li({ status: "failed" })], { status: "partial" })])).toMatchObject({ failed: 1, title: "1 post needs a look" });
    expect(socialSummary([])?.title).toBe("No posts yet");
    expect(healthChip({ status: "active" }, null).label).toBe("Ready to post");
    expect(healthChip({ status: "expired" }, null).label).toBe("Sign in expired");
    expect(healthChip({ status: "active" }, { accountId: "a", app: "linkedin", ok: false, code: "no_permission", text: null }).label).toBe("Posting not allowed");
    expect(healthChip({ status: "active" }, { accountId: "a", app: "facebook", ok: false, code: "not_page_admin", text: null }).label).toBe("Page not reachable");
  });

  it("lifts the composer footer by exactly the part the keyboard covers", () => {
    expect(keyboardOverlap(844, 508)).toBe(336);
    expect(keyboardOverlap(500, 508)).toBe(0);
  });

  it("copy has no long dashes", () => {
    for (const f of ["src/app/social.tsx", "src/app/social-post/[id].tsx", "src/app/social-posted/[id].tsx", "src/components/social.tsx", "src/lib/social.ts"]) {
      expect(readFileSync(join(__dirname, "..", f), "utf8")).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe("header and safe area guard", () => {
  const layout = readFileSync(join(__dirname, "..", "src/app/_layout.tsx"), "utf8");
  it("Social and its pages use the fixed header, not a large title", () => {
    for (const name of ["social", "social-post/[id]", "social-posted/[id]"]) {
      const line = layout.split("\n").find((l) => l.includes(`name="${name}"`));
      expect(line).toBeTruthy();
      expect(line).toContain("headerLargeTitle: false");
    }
  });
  it("every large title screen has one root scroll view with automatic insets", () => {
    const names = [...layout.matchAll(/name="([^"]+)" options=\{\{ headerLargeTitle: true/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(5);
    for (const n of names) {
      const src = readFileSync(join(__dirname, "..", "src/app", `${n}.tsx`), "utf8");
      const viaComponent = n === "notifications" ? readFileSync(join(__dirname, "..", "src/components/notifications-legacy.tsx"), "utf8") : "";
      expect(`${src}${viaComponent}`).toMatch(/contentInsetAdjustmentBehavior="automatic"/);
    }
  });
});

describe("Social screens", () => {
  let transport: SampleTransport;
  const wrap = async (ui: ReactNode) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={qc}><SessionProvider initialMode="sample" transportOverride={transport}>{ui}</SessionProvider></QueryClientProvider>);
  };
  beforeEach(() => { transport = new SampleTransport(); mockParams = {}; clearSocialToast(); setOffline(false); jest.clearAllMocks(); });

  it("pins the parts and filters above the one list, and checks the posts with Facebook on open", async () => {
    const spy = jest.spyOn(transport, "request");
    const Social = require("@/app/social").default;
    await wrap(<Social />);
    const list = await screen.findByTestId("social-posts");
    const pinned = screen.getByTestId("social-pinned");
    expect(within(list).queryByTestId("social-pinned")).toBeNull();
    expect(within(pinned).getByTestId("filter-failed")).toBeTruthy();
    expect(list.props.contentInsetAdjustmentBehavior).toBe("never");
    // The bottom of the list clears the home indicator.
    expect(list.props.contentContainerStyle.paddingBottom).toBeGreaterThanOrEqual(34);
    await waitFor(() => expect(spy).toHaveBeenCalledWith("POST", "/social/posts/sync", { ids: ["sp_2"] }));
    expect(screen.getByText("Removed on Facebook")).toBeTruthy();
    expect(screen.getByText("Deleted on LinkedIn? Delete it here too.")).toBeTruthy();
    expect(within(screen.getByTestId("filter-failed")).getByText("1")).toBeTruthy();
  });

  it("post page: removed on Facebook, the LinkedIn note, and Delete that names only LinkedIn", async () => {
    mockParams = { id: "sp_1" };
    const spy = jest.spyOn(transport, "request");
    const SocialPost = require("@/app/social-post/[id]").default;
    await wrap(<SocialPost />);
    expect(await screen.findByTestId("removed-note")).toHaveTextContent("This post was deleted on Facebook. There is nothing left to open.");
    expect(screen.queryByTestId("open-post-facebook")).toBeNull();
    expect(screen.getByTestId("open-post-linkedin")).toBeTruthy();
    expect(screen.getByTestId("linkedin-note")).toHaveTextContent(LINKEDIN_DELETE_NOTE);
    expect(screen.getByTestId("checked-line")).toHaveTextContent(/^Checked with Facebook/);
    await fireEvent.press(screen.getByTestId("post-delete"));
    expect(screen.getByTestId("delete-sheet-body")).toHaveTextContent("It will also be deleted from LinkedIn. You can't undo this.");
    await fireEvent.press(screen.getByTestId("delete-sheet-confirm"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("DELETE", "/social/posts/sp_1"));
    await waitFor(() => expect(currentSocialToast()?.text).toBe("Post deleted from Facebook and LinkedIn"));
    expect(require("expo-router").router.back).toHaveBeenCalled();
  });

  it("post page: a delete a network refuses keeps the post and says which network", async () => {
    mockParams = { id: "sp_1" };
    const real = transport.request.bind(transport);
    jest.spyOn(transport, "request").mockImplementation(async (method: string, path: string, body?: unknown) => {
      if (method === "DELETE") {
        const p = sampleSocial(Date.now()).posts.find((x) => x.id === "sp_1")!;
        return { deleted: false, post: p, results: [{ accountId: "ca_fb", app: "facebook", outcome: "already_gone" }, { accountId: "ca_li", app: "linkedin", outcome: "failed" }] } as never;
      }
      return real(method as never, path, body) as never;
    });
    const SocialPost = require("@/app/social-post/[id]").default;
    await wrap(<SocialPost />);
    await fireEvent.press(await screen.findByTestId("post-delete"));
    await fireEvent.press(screen.getByTestId("delete-sheet-confirm"));
    await waitFor(() => expect(currentSocialToast()).toEqual(expect.objectContaining({ tone: "bad", text: "Deleted from Facebook. LinkedIn didn't delete it. Try again in a minute." })));
    expect(require("expo-router").router.back).not.toHaveBeenCalled();
    expect(screen.getByTestId("social-post")).toBeTruthy();
  });

  it("post page: a network that turned it down shows its reason, Reconnect and Try again", async () => {
    mockParams = { id: "sp_2" };
    const SocialPost = require("@/app/social-post/[id]").default;
    await wrap(<SocialPost />);
    expect(await screen.findByTestId("post-error")).toHaveTextContent(/has not allowed posting/);
    expect(screen.getByText("Reconnect LinkedIn")).toBeTruthy();
    expect(screen.getByTestId("posted-count")).toHaveTextContent("Posted to 1 of 2");
    await fireEvent.press(screen.getByTestId("post-retry"));
    await waitFor(() => expect(screen.queryByTestId("post-error")).toBeNull());
  });

  it("after Post now: follows each network to its tick, then says it in the web's words", async () => {
    const created = await transport.request<{ post: SocialPostView }>("POST", "/social/posts", { text: "Fresh bread", targets: [{ accountId: "ca_fb", target: "pg_1", targetName: "Harbour Bakery" }, { accountId: "ca_li" }] });
    mockParams = { id: created.post.id };
    const SocialPosted = require("@/app/social-posted/[id]").default;
    await wrap(<SocialPosted />);
    expect(await screen.findByText("Posting now")).toBeTruthy();
    // The sample server sends 2.5 seconds after saving, as the real one does right after it answers.
    await waitFor(() => expect(screen.getByText("Posted to all 2 accounts")).toBeTruthy(), { timeout: 8000 });
    expect(screen.getByTestId("open-post-facebook")).toBeTruthy();
    expect(screen.getByTestId("linkedin-note")).toBeTruthy();
    expect(screen.getByText("Write another")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("view-in-posts"));
    expect(require("expo-router").router.back).toHaveBeenCalled();
    expect(require("@/lib/social-queries").currentSocialTab()?.tab).toBe("posts");
  }, 15000);

  it("composer: offline turns Post off and says why", async () => {
    mockParams = { tab: "new" };
    const Social = require("@/app/social").default;
    await wrap(<Social />);
    await fireEvent.changeText(await screen.findByTestId("social-text"), "Hello");
    await fireEvent.press(screen.getByTestId("pick-linkedin"));
    expect(screen.getByTestId("social-send")).not.toBeDisabled();
    await act(async () => { setOffline(true); });
    expect(screen.getByTestId("social-send")).toBeDisabled();
    expect(screen.getByTestId("social-count")).toHaveTextContent("You're offline. You can post when you're back.");
    // The footer clears the home indicator when the keyboard is down.
    expect(screen.getByTestId("social-footer").props.style).toEqual(expect.arrayContaining([expect.objectContaining({ paddingBottom: 34 + 8 })]));
  });

  it("a server from before the delete and check routes still shows posts", async () => {
    const real = transport.request.bind(transport);
    jest.spyOn(transport, "request").mockImplementation(async (method: string, path: string, body?: unknown) => {
      if (path === "/social/posts/sync") { const { ApiError } = require("@/api/errors"); throw new ApiError(404, "not_found", "Not found."); }
      return real(method as never, path, body) as never;
    });
    const Social = require("@/app/social").default;
    await wrap(<Social />);
    expect(await screen.findByText("Partly posted")).toBeTruthy();
  });

  it("the command sheet opens New social post and Social posts", () => {
    const navigate = jest.fn();
    const h = createHandlers({ navigate, openWeb: jest.fn() });
    h["social-new"]({});
    h.social({});
    expect(navigate).toHaveBeenCalledWith({ pathname: "/social", params: { tab: "new" } });
    expect(navigate).toHaveBeenCalledWith("/social");
    expect(COMMANDS.find((c) => c.id === "social-new")?.title).toBe("New social post");
  });
});
