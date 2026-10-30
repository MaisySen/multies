import { describe, expect, it } from "vitest";
import { chatQuery, closedWindowCopy, connectErrorCopy, fileTooBig, fillTemplate, mergeByDate, parseSignupMessage, windowPill } from "../src/web/lib/chat-channels";

/** C1 (chat channels, phase 1): the pure logic behind the chat UI in the shared inbox and Settings, Channels. */
describe("C1 chat UI logic", () => {
  const now = new Date("2026-10-28T12:00:00Z");

  it("window pill: hours left, amber under 2 h, closed", () => {
    expect(windowPill({ open: true, closesAt: "2026-10-28T15:30:00Z" }, now)).toEqual({ label: "Reply window closes in 3 h", tone: "ok" });
    expect(windowPill({ open: true, closesAt: "2026-10-28T13:30:00Z" }, now)).toEqual({ label: "Reply window closes in 1 h", tone: "warn" });
    expect(windowPill({ open: true, closesAt: "2026-10-28T12:20:00Z" }, now)).toEqual({ label: "Reply window closes in 20 min", tone: "warn" });
    expect(windowPill({ open: false, closesAt: "2026-10-27T12:00:00Z" }, now)).toEqual({ label: "Reply window closed", tone: "closed" });
    expect(windowPill({ open: false, closesAt: null }, now).tone).toBe("closed");
  });

  it("closed window copy names the channel; the test channel reads as WhatsApp", () => {
    expect(closedWindowCopy("whatsapp")).toBe("It has been more than 24 hours since this customer wrote, so WhatsApp only allows an approved template.");
    expect(closedWindowCopy("mock")).toContain("WhatsApp only allows");
    expect(closedWindowCopy("instagram")).toContain("Instagram only allows");
  });

  it("maps the mail views onto conversation filters", () => {
    expect(chatQuery("open", null)).toEqual({ qs: "?limit=50", hideDone: true });
    expect(chatQuery("mine", null).qs).toContain("assignee=me");
    expect(chatQuery("unassigned", null).qs).toContain("assignee=none");
    expect(chatQuery("assigned", "u_1").qs).toContain("assignee=u_1");
    expect(chatQuery("waiting", null)).toEqual({ qs: "?limit=50&status=waiting", hideDone: false });
    expect(chatQuery("done", null)).toEqual({ qs: "?limit=50&status=done", hideDone: false });
  });

  it("merges mail and chats newest first", () => {
    const rows = mergeByDate([{ id: "m1", lastMessageAt: "2026-10-28T10:00:00Z" }, { id: "m2", lastMessageAt: "2026-10-28T08:00:00Z" }], [{ id: "c1", lastMessageAt: "2026-10-28T09:00:00Z" }]);
    expect(rows.map((r) => `${r.kind}:${r.item.id}`)).toEqual(["mail:m1", "chat:c1", "mail:m2"]);
  });

  it("fills template placeholders and keeps the empty ones", () => {
    expect(fillTemplate("Hi {{1}}, order {{2}} is ready", ["Priya", ""])).toBe("Hi Priya, order {{2}} is ready");
  });

  it("files over 5 MB get a plain error", () => {
    expect(fileTooBig("a.pdf", 5 * 1024 * 1024)).toBeNull();
    expect(fileTooBig("big.mov", 6 * 1024 * 1024)).toBe("big.mov is 6.0 MB. Files can be up to 5 MB.");
  });

  it("reads the Embedded Signup window message only from facebook.com", () => {
    const finish = JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: { phone_number_id: "106540352242922", waba_id: "102290129340398" } });
    expect(parseSignupMessage("https://www.facebook.com", finish)).toEqual({ kind: "finish", phoneNumberId: "106540352242922", wabaId: "102290129340398" });
    expect(parseSignupMessage("https://web.facebook.com", finish)?.kind).toBe("finish");
    expect(parseSignupMessage("https://evil.example", finish)).toBeNull();
    expect(parseSignupMessage("https://facebook.com.evil.example", finish)).toBeNull();
    expect(parseSignupMessage("https://www.facebook.com", JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", data: { phone_number_id: "1", waba_id: "2" } }))?.kind).toBe("finish");
    expect(parseSignupMessage("https://www.facebook.com", JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: { current_step: "PHONE_NUMBER_SETUP" } }))).toEqual({ kind: "cancel", step: "PHONE_NUMBER_SETUP" });
    expect(parseSignupMessage("https://www.facebook.com", JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "ERROR", data: { error_message: "Number already in use" } }))).toEqual({ kind: "error", message: "Number already in use" });
    expect(parseSignupMessage("https://www.facebook.com", JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: {} }))).toEqual({ kind: "error", message: null });
    expect(parseSignupMessage("https://www.facebook.com", JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: { error_message: "Session expired", error_code: "524126", session_id: "s1" } }))).toEqual({ kind: "error", message: "Session expired" });
    // v5 names the account messaging_account_ids.
    expect(parseSignupMessage("https://www.facebook.com", JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: { phone_number_id: "1", messaging_account_ids: ["9"], is_on_biz_app: true } }))).toEqual({ kind: "finish", phoneNumberId: "1", wabaId: "9" });
    expect(parseSignupMessage("https://www.facebook.com", JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH_ONLY_WABA", data: { waba_id: "9" } }))).toEqual({ kind: "error", message: null });
    expect(parseSignupMessage("https://evilfacebook.com", JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: { phone_number_id: "1", waba_id: "2" } }))).toBeNull();
    expect(parseSignupMessage("https://www.facebook.com", "not json")).toBeNull();
    expect(parseSignupMessage("https://www.facebook.com", JSON.stringify({ type: "OTHER" }))).toBeNull();
  });

  it("plain error copy for each connect failure, with no dashes", () => {
    for (const code of ["sdk_failed", "sdk_timeout", "cancelled", "no_code", "no_number", "meta_error", "other"]) {
      const s = connectErrorCopy(code);
      expect(s.length).toBeGreaterThan(10);
      expect(s).not.toMatch(/[\u2013\u2014]/);
    }
    expect(connectErrorCopy("meta_error", "Number already in use")).toBe("Facebook stopped the setup: Number already in use");
  });
});
