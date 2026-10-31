import { describe, expect, it } from "vitest";
import {
  addBusinessMinutes, bestAnswer, businessMinutesBetween, changePriority, cleanVisitorText, defaultSettings, isOpenAt, localToUtc,
  newClock, nextOpening, normalizeDomain, onCustomerMessage, onTeamReply, originAllowed, planMacro, readSettings, slaLabel, slaView,
  transition, MacroInput, type BusinessHours, type SlaConfig,
} from "@/shared/helpdesk";

const MIN = 60_000;
const syd = (y: number, m: number, d: number, h: number, mi = 0) => localToUtc(y, m, d, h * 60 + mi, "Australia/Sydney");
const hours: BusinessHours = defaultSettings("Australia/Sydney").hours; // Mon to Fri 9 to 5
const cfg: SlaConfig = { hours, sla: defaultSettings().sla };

describe("business hours", () => {
  it("counts only open time, across a night and a weekend", () => {
    // Fri 4pm to Mon 10am = 1h Friday + 1h Monday
    expect(businessMinutesBetween(syd(2026, 10, 30, 16), syd(2026, 11, 2, 10), hours)).toBe(120);
    expect(businessMinutesBetween(syd(2026, 11, 2, 10), syd(2026, 11, 2, 9), hours)).toBe(0);
  });
  it("adds working minutes, skipping closed time and holidays", () => {
    expect(addBusinessMinutes(syd(2026, 10, 30, 16, 30), 60, hours)).toBe(syd(2026, 11, 2, 9, 30));
    const h = { ...hours, holidays: ["2026-11-02"] };
    expect(addBusinessMinutes(syd(2026, 10, 30, 16, 30), 60, h)).toBe(syd(2026, 11, 3, 9, 30));
    // starting before opening counts from opening
    expect(addBusinessMinutes(syd(2026, 11, 3, 7), 30, hours)).toBe(syd(2026, 11, 3, 9, 30));
  });
  it("handles the daylight saving change (Sydney, 5 Oct 2026)", () => {
    // Fri 2 Oct 4pm to Mon 5 Oct 10am still = 2 working hours, though the clocks moved
    expect(businessMinutesBetween(syd(2026, 10, 2, 16), syd(2026, 10, 5, 10), hours)).toBe(120);
    expect(syd(2026, 10, 5, 9) - syd(2026, 10, 2, 9)).toBe(3 * 86_400_000 - 60 * MIN);
  });
  it("always open and no open day both mean every minute counts", () => {
    const t = syd(2026, 11, 1, 3);
    expect(businessMinutesBetween(t, t + 90 * MIN, { ...hours, always: true })).toBe(90);
    expect(addBusinessMinutes(t, 90, { ...hours, days: [null, null, null, null, null, null, null] })).toBe(t + 90 * MIN);
    expect(businessMinutesBetween(t, t + 30 * MIN, null)).toBe(30);
  });
  it("knows when the team is open and when it opens next", () => {
    expect(isOpenAt(syd(2026, 11, 2, 10), hours)).toBe(true);
    expect(isOpenAt(syd(2026, 11, 1, 10), hours)).toBe(false); // Sunday
    expect(isOpenAt(syd(2026, 11, 2, 17), hours)).toBe(false); // closing minute
    expect(nextOpening(syd(2026, 11, 1, 10), hours)).toBe(syd(2026, 11, 2, 9));
  });
});

describe("SLA clocks", () => {
  const t0 = syd(2026, 11, 2, 9); // Monday opening
  it("starts both clocks from the priority's targets", () => {
    const c = newClock(t0, "high", cfg); // 4h first reply, 24h resolve (3 working days)
    expect(c.firstReplyDueAt).toBe(syd(2026, 11, 2, 13));
    expect(c.resolveDueAt).toBe(syd(2026, 11, 4, 17));
  });
  it("pauses while waiting on the customer and resumes with the time left", () => {
    let c = newClock(t0, "urgent", cfg); // 4h resolve
    c = transition(c, "pending", t0 + 60 * MIN, cfg);
    expect(c.runningSince).toBeNull();
    expect(c.resolveUsedMin).toBe(60);
    expect(slaView(c, t0 + 120 * MIN, cfg).resolve.level).toBe("paused");
    c = onCustomerMessage(c, syd(2026, 11, 3, 9), cfg); // reopens next morning
    expect(c.status).toBe("open");
    expect(c.resolveDueAt).toBe(syd(2026, 11, 3, 12));
  });
  it("warns at a quarter of the target left and breaches after the due time", () => {
    const c = newClock(t0, "urgent", cfg); // first reply 60 min
    expect(slaView(c, t0 + 30 * MIN, cfg).first.level).toBe("ok");
    expect(slaView(c, t0 + 46 * MIN, cfg).first.level).toBe("warn");
    const v = slaView(c, t0 + 75 * MIN, cfg);
    expect(v.first.level).toBe("breached");
    expect(v.worst).toBe("breached");
    expect(slaLabel(v.first, "First reply")).toBe("First reply overdue by 15m");
  });
  it("a first reply stops the first clock for good", () => {
    let c = newClock(t0, "normal", cfg);
    c = onTeamReply(c, t0 + 10 * MIN);
    const again = onTeamReply(c, t0 + 99 * MIN);
    expect(again.firstReplyAt).toBe(t0 + 10 * MIN);
    expect(slaView(again, t0 + 600 * MIN, cfg).first.level).toBe("met");
  });
  it("solving stops the clocks; reopening carries the used time", () => {
    let c = newClock(t0, "urgent", cfg);
    c = transition(c, "solved", t0 + 200 * MIN, cfg);
    expect(c.solvedAt).toBe(t0 + 200 * MIN);
    expect(slaView(c, t0 + 999 * MIN, cfg).worst).toBe("met");
    c = transition(c, "open", t0 + 230 * MIN, cfg);
    expect(c.resolveDueAt).toBe(t0 + 270 * MIN);
    expect(c.solvedAt).toBeNull();
  });
  it("a resolve clock already over its target stays overdue after a pause", () => {
    let c = newClock(t0, "urgent", cfg);
    c = transition(c, "on_hold", t0 + 300 * MIN, cfg); // 60 min over
    expect(slaView(c, t0 + 301 * MIN, cfg).resolve.level).toBe("breached");
    c = transition(c, "open", t0 + 400 * MIN, cfg);
    expect(c.resolveDueAt).toBe(t0 + 340 * MIN);
  });
  it("same status changes nothing, a new priority moves the due times", () => {
    const c = newClock(t0, "low", cfg);
    expect(transition(c, "open", t0 + MIN, cfg)).toBe(c);
    const u = changePriority(c, "urgent", t0 + 30 * MIN, cfg);
    expect(u.firstReplyDueAt).toBe(t0 + 60 * MIN);
    expect(u.resolveDueAt).toBe(t0 + 240 * MIN);
  });
});

describe("macros", () => {
  it("folds steps in order, later wins, notes add up", () => {
    const steps = MacroInput.parse({ name: "Refund done", steps: [
      { type: "assign", to: "me" }, { type: "priority", priority: "high" }, { type: "note", text: "Refunded" },
      { type: "status", status: "pending" }, { type: "status", status: "solved" }, { type: "reply", snippetId: "snp1" }, { type: "note", text: "Told them" },
    ] }).steps;
    const p = planMacro(steps, "u1");
    expect(p).toEqual({ assignee: "u1", priority: "high", status: "solved", notes: ["Refunded", "Told them"], reply: { text: null, snippetId: "snp1" } });
    expect(planMacro([{ type: "assign", to: "none" }], "u1").assignee).toBeNull();
  });
  it("rejects empty and oversized macros", () => {
    expect(MacroInput.safeParse({ name: "x", steps: [] }).success).toBe(false);
    expect(MacroInput.safeParse({ name: "x", steps: [{ type: "reply" }] }).success).toBe(false);
    expect(MacroInput.safeParse({ name: "x", steps: Array.from({ length: 11 }, () => ({ type: "status", status: "open" })) }).success).toBe(false);
  });
});

describe("automatic answers", () => {
  const replies = [
    { id: "a", name: "Refund policy", body: "You can get a full refund within 30 days of purchase." },
    { id: "b", name: "Opening hours", body: "We are open Monday to Friday, 9 to 5." },
    { id: "c", name: "Shipping times", body: "Orders ship within two business days." },
  ];
  it("finds the saved reply whose name answers the question", () => {
    expect(bestAnswer("Hi, what is your refund policy?", replies)?.id).toBe("a");
    expect(bestAnswer("what are your opening hours", replies)?.id).toBe("b");
    expect(bestAnswer("how long does shipping take for orders", replies)?.id).toBe("c");
  });
  it("stays quiet when nothing clearly matches", () => {
    expect(bestAnswer("my invoice shows the wrong address", replies)).toBeNull();
    expect(bestAnswer("hello", replies)).toBeNull();
    expect(bestAnswer("refund my order, it arrived broken and the box was wet and torn", replies)).toBeNull();
  });
});

describe("website chat guard", () => {
  it("normalises domains as typed", () => {
    expect(normalizeDomain("https://www.Shop.com/path?x")).toBe("www.shop.com");
    expect(normalizeDomain("*.shop.com")).toBe("shop.com");
    expect(normalizeDomain("not a domain")).toBeNull();
    expect(normalizeDomain("localhost")).toBe("localhost");
  });
  it("allows listed domains and their subdomains only", () => {
    expect(originAllowed("https://shop.com", ["shop.com"])).toBe(true);
    expect(originAllowed("https://www.shop.com", ["shop.com"])).toBe(true);
    expect(originAllowed("https://evilshop.com", ["shop.com"])).toBe(false);
    expect(originAllowed("https://shop.com.evil.io", ["shop.com"])).toBe(false);
    expect(originAllowed(null, ["shop.com"])).toBe(false);
    expect(originAllowed("file://x", ["shop.com"])).toBe(false);
    expect(originAllowed("https://app.example", [], ["https://app.example"])).toBe(true);
  });
  it("cleans visitor text", () => {
    expect(cleanVisitorText("  hi\u0000 there\u202E \r\n\n\n\n\nbye ")).toBe("hi there \n\n\nbye");
    expect(cleanVisitorText("x".repeat(3000)).length).toBe(2000);
  });
  it("reads broken settings back to the defaults part by part", () => {
    const s = readSettings(JSON.stringify({ mailboxIds: ["m1"], hours: { nonsense: true }, widget: { on: true, domains: ["a.com"] } }), "Europe/London");
    expect(s.mailboxIds).toEqual(["m1"]);
    expect(s.hours.timezone).toBe("Europe/London");
    expect(s.widget.on).toBe(true);
    expect(readSettings("not json").chats).toBe(false);
  });
});
