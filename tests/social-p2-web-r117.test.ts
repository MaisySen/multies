import { describe, expect, it } from "vitest";
import { deleteReach, postMatches } from "../src/web/pages/app/apps-social";
import { onDay } from "../src/web/pages/app/social-planner";
import { composerAccounts } from "../src/web/pages/app/social-composer";
import { visibleSections } from "../src/web/layouts/shell-nav";
import { WHATS_NEW } from "../src/shared/whats-new";
import type { SocialPostView } from "../src/shared/integrations";

const t = (app: string, accountId: string, over: Record<string, unknown> = {}) => ({ accountId, app, label: null, target: null, targetName: null, status: "sent", error: null, errorCode: null, url: null, externalId: "x", sentAt: null, canDelete: app === "facebook", networkState: null, ...over });
const post = (targets: ReturnType<typeof t>[], status = "done") => ({ id: "p1", text: "hi", imageUrl: null, runAt: new Date().toISOString(), status, createdAt: new Date().toISOString(), createdBy: "u1", targets }) as unknown as SocialPostView;

describe("R117 delete confirm reach", () => {
  it("names only networks Multies will delete from, Facebook first", () => {
    const p = post([t("linkedin", "li1", { canDelete: true }), t("facebook", "fb1"), t("instagram", "ig1")]);
    expect(deleteReach(p, new Set(["li1", "fb1", "ig1"]))).toEqual({ on: ["Facebook", "LinkedIn"], stays: ["Instagram"] });
  });
  it("a disconnected account counts under stays", () => {
    const p = post([t("facebook", "fb1"), t("linkedin", "li1")]);
    const r = deleteReach(p, new Set(["li1"]));
    expect(r.on).toEqual([]);
    expect(r.stays).toEqual(["Facebook", "LinkedIn"]);
  });
  it("without the account list it trusts canDelete (as before)", () => {
    expect(deleteReach(post([t("facebook", "fb1")])).on).toEqual(["Facebook"]);
  });
  it("removed and unsent targets are not named", () => {
    const p = post([t("facebook", "fb1", { networkState: "removed" }), t("facebook", "fb2", { status: "failed" })]);
    expect(deleteReach(p, new Set(["fb1", "fb2"]))).toEqual({ on: [], stays: [] });
  });
});

describe("R117 posts filters", () => {
  it("drafts and waiting have their own filters and stay out of All", () => {
    const d = post([], "draft"), w = post([], "review"), s = post([], "scheduled"), c = post([], "changes");
    expect([d, w, s, c].filter((p) => postMatches(p, "all")).map((p) => p.status)).toEqual(["scheduled"]);
    expect([d, w, s, c].filter((p) => postMatches(p, "drafts")).map((p) => p.status)).toEqual(["draft", "changes"]);
    expect([d, w, s, c].filter((p) => postMatches(p, "waiting")).map((p) => p.status)).toEqual(["review"]);
  });
});

describe("R117 planner and composer helpers", () => {
  it("a drop on a day keeps the post's clock time", () => {
    const r = onDay(new Date(2026, 10, 3, 9, 30), new Date(2026, 10, 6));
    expect([r.getDate(), r.getHours(), r.getMinutes()]).toEqual([6, 9, 30]);
  });
  it("composer accounts: active social apps plus linked TikTok and Threads, not expired ones", () => {
    const acc = (id: string, app: string, status = "active") => ({ id, app, appName: app, status, label: null }) as never;
    const list = composerAccounts([acc("a", "facebook"), acc("b", "linkedin", "expired"), acc("c", "github")], {
      accounts: [{ provider: "tiktok", connected: true, status: "active", username: "shop" }, { provider: "threads", connected: true, status: "expired", username: "x" }],
    } as never);
    expect(list.map((a) => a.id)).toEqual(["a", "direct:tiktok"]);
  });
  it("Library sits in the nav only with the flag", () => {
    const social = (f: Record<string, boolean>) => visibleSections(f).find((s) => s.id === "social")!.pages.map((p) => p.label);
    expect(social({})).not.toContain("Library");
    expect(social({ socialP2: true })).toContain("Library");
  });
  it("what's new stays at 14 with the planner entry near the top", () => {
    expect(WHATS_NEW.length).toBeLessThanOrEqual(14);
    // R97: newer rounds add their entry above; the planner entry stays in the list, without dashes.
    const planner = WHATS_NEW.find((e) => e.id === "2026-10-31-social-planner-library");
    expect(planner).toBeTruthy();
    expect(planner!.body).not.toMatch(/[\u2013\u2014-]/);
  });
});
