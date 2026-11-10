import { describe, it, expect, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { privacyWorld, inboundMail } from "./priv1a-world";
import { aliases, deliveries, messages } from "@/server/db/schema";
import { deliverInbound } from "@/server/services/mail/delivery";

/** PRIV1b integration S1: a failing forward check refuses the forward but keeps the delivery, so the MTA doesn't retry and store twice. */
const flag = vi.hoisted(() => ({ fail: false }));
vi.mock("@/server/services/abuse", async (orig) => {
  const m = await orig<typeof import("@/server/services/abuse")>();
  return { ...m, recentOutboundStats: (...a: Parameters<typeof m.recentOutboundStats>) => (flag.fail ? Promise.reject(new Error("D1 timeout")) : m.recentOutboundStats(...a)) };
});

describe("PRIV1b integration S1: forward check errors", () => {
  it("an alias with a team copy and an outside forward: the copy is stored once and the forward is refused; when the check works it forwards", async () => {
    const w = await privacyWorld();
    await w.ctx.db.insert(aliases).values({ id: `ali_s1${w.n}aaaaaaaaa`, orgId: w.orgId, domainId: w.domainId, localPart: `sales${w.n}`, address: `sales${w.n}@acme.io`, destinations: JSON.stringify(["team@acme.io", "boss@outside.example"]) });
    const reported: unknown[] = [];
    const deps = { ...w.ctx.deps, reportError: (e: unknown) => { reported.push(e); return undefined; } };
    flag.fail = true;
    const r = await deliverInbound(deps, inboundMail(`sales${w.n}@acme.io`, "client@example.com", "S1 broken check", "hi"));
    flag.fail = false;
    expect(r.code).toBe(250);
    expect(r.accepted).toBe(true);
    expect(r.forwardedTo).toEqual([]);
    expect(r.storedIn.length).toBe(1);
    expect(reported.length).toBe(1);
    const copies = await w.ctx.db.select().from(messages).where(and(eq(messages.mailboxId, w.boxes.team), eq(messages.subject, "S1 broken check")));
    expect(copies.length).toBe(1);
    const log = await w.ctx.db.select().from(deliveries).where(and(eq(deliveries.toAddress, "boss@outside.example"), eq(deliveries.status, "rejected")));
    expect(log.map((x) => x.detail)).toEqual(["Forward check failed"]);
    expect(w.ctx.outbound.sent.some((m) => m.subject === "S1 broken check")).toBe(false);

    // Legitimate: the check works, the outside copy goes out.
    const ok = await deliverInbound(deps, inboundMail(`sales${w.n}@acme.io`, "client@example.com", "S1 ok", "hi"));
    expect(ok.code).toBe(250);
    expect(ok.forwardedTo).toEqual(["boss@outside.example"]);
  }, 120_000);
});
