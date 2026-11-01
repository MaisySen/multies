/**
 * R100b low follow ups (R96 Chat plus, R118 Social): Block reason copy, chat opens at the newest message.
 * The browser side (no TikTok check when TikTok is not connected, Post now toast and return to Posts, announcement
 * reactions, chat at the newest message) is covered in e2e/tools-c2-r100b.spec.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DECISION_BLOCK_NEEDS_REASON, DECISION_REASON_PLACEHOLDER } from "@/shared/chat-plus";
import { nearBottom } from "@/web/lib/stick-to-bottom";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("R100b chat plus lows", () => {
  it("the decision reason never says optional and Block asks for a reason", () => {
    expect(DECISION_REASON_PLACEHOLDER).toBe("Add a reason");
    expect(DECISION_BLOCK_NEEDS_REASON).toBe("Add a reason to block");
    const page = src("src/web/pages/app/work/chat-plus-r96.tsx");
    expect(page).not.toContain("Add a reason (optional)");
    expect(page).toContain("decision-reason-error");
  });
  it("follows the bottom only while the reader is near it", () => {
    expect(nearBottom({ scrollHeight: 2000, scrollTop: 1500, clientHeight: 500 })).toBe(true);
    expect(nearBottom({ scrollHeight: 2000, scrollTop: 1420, clientHeight: 500 })).toBe(true);
    expect(nearBottom({ scrollHeight: 2000, scrollTop: 900, clientHeight: 500 })).toBe(false);
    expect(nearBottom({ scrollHeight: 300, scrollTop: 0, clientHeight: 500 })).toBe(true);
  });
  it("announcements in the feed take reactions", () => {
    const page = src("src/web/pages/app/work/chat-plus-r96.tsx");
    expect(page).toMatch(/AnnouncementsFeed[\s\S]*<Reactions [\s\S]*<ReactionPicker/);
  });
});

describe("R100b social lows", () => {
  it("the TikTok check runs only while the TikTok dialog is open", () => {
    expect(src("src/web/pages/app/apps-direct.tsx")).toMatch(/"\/direct\/tiktok\/creator"[^\n]*enabled: open/);
  });
  it("Post now confirms with a toast and closing the sheet returns to Posts", () => {
    const c = src("src/web/pages/app/social-composer.tsx");
    expect(c).toContain('export const POST_NOW_TOAST = "Posting now. Follow it in Posts."');
    expect(c).toContain("toast.success(POST_NOW_TOAST)");
    expect(c).toMatch(/onClose=\{\(\) => \{ setPostedId\(null\); if \(tiktokAfter !== null\) setTiktokOpen\(true\); else navigate\("\/app\/social\/posts"\); \}\}/);
  });
});
