import { describe, expect, it } from "vitest";
import { notificationFor, PUSH_MAX_AGE_MS, pushDecision, samePage } from "@/web/sw/sw-routes";

const O = "https://multies.si";
const now = Date.parse("2026-10-26T11:00:00Z");

describe("R33 push: skip the page already open, drop stale pushes", () => {
  it("skips when a focused visible window is on the same page and says which", () => {
    const clients = [{ url: `${O}/app/mail`, focused: false }, { url: `${O}/app/chat/c1`, focused: true, visibilityState: "visible" }];
    expect(pushDecision({ url: "/app/chat/c1", sentAt: now }, clients, O, now)).toEqual({ action: "skip", client: 1 });
  });

  it("shows when the window is on another page, hidden, or not focused", () => {
    expect(pushDecision({ url: "/app/chat/c1" }, [{ url: `${O}/app/chat/c2`, focused: true }], O, now).action).toBe("show");
    expect(pushDecision({ url: "/app/chat/c1" }, [{ url: `${O}/app/chat/c1`, focused: true, visibilityState: "hidden" }], O, now).action).toBe("show");
    expect(pushDecision({ url: "/app/chat/c1" }, [{ url: `${O}/app/chat/c1`, focused: false }], O, now).action).toBe("show");
    expect(pushDecision({ url: "/app/chat/c1" }, [], O, now).action).toBe("show");
  });

  it("a push with no usable url always shows (it opens the notifications page)", () => {
    expect(pushDecision({ url: "https://evil.example/app" }, [{ url: `${O}/app/notifications`, focused: true }], O, now).action).toBe("show");
  });

  it("matches the task query and ignores the hash and a trailing slash", () => {
    expect(samePage(`${O}/app/tasks?task=t1#c`, "/app/tasks?task=t1", O)).toBe(true);
    expect(samePage(`${O}/app/chat/c1/`, "/app/chat/c1", O)).toBe(true);
    expect(samePage(`${O}/app/tasks?task=t1`, "/app/tasks?task=t2", O)).toBe(false);
    expect(samePage("https://other.example/app/chat/c1", "/app/chat/c1", O)).toBe(false);
  });

  it("drops a push older than its TTL, capped at six hours", () => {
    expect(pushDecision({ url: "/app/mail", sentAt: now - 120_000, ttl: 60 }, [], O, now).action).toBe("drop");
    expect(pushDecision({ url: "/app/mail", sentAt: now - 30_000, ttl: 60 }, [], O, now).action).toBe("show");
    expect(pushDecision({ url: "/app/mail", sentAt: now - PUSH_MAX_AGE_MS - 1 }, [], O, now).action).toBe("drop");
    expect(pushDecision({ url: "/app/mail", sentAt: new Date(now - 1000).toISOString() }, [], O, now).action).toBe("show");
    expect(pushDecision({ url: "/app/mail" }, [], O, now).action).toBe("show");
  });

  it("tags by item so a repeat replaces the earlier alert", () => {
    const n = notificationFor({ title: "New message", url: "/app/chat/c1", tag: "chat:c1" });
    expect(n.options.tag).toBe("chat:c1");
    expect(n.options.renotify).toBe(false);
  });
});
