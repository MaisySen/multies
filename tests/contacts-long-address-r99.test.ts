import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { messages } from "@/server/db/schema";

/**
 * R99 (verifier v8 on staging): the first contacts in the list opened "Contact not found". The detail answered 500
 * because D1 refuses a LIKE pattern longer than 50 bytes and the "mail with this person" query built
 * `%"address":"<email>"%`, so every address of 37 characters or more failed (staging test addresses are long; real
 * ones can be too). The test database is SQLite without that limit, so this file installs D1's rule on LIKE.
 */
type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
let ctx: Ctx;
let owner: Client;
let mailboxId = "";
const LONG = "someone.with.a.long.address@subsidiary.example-company.com"; // 58 characters
const SHORT = "ann@ex.com";

/** D1's LIKE: patterns over 50 bytes fail; otherwise SQLite's case insensitive LIKE with % and _. */
function d1Like(db: { function: (name: string, opts: object, fn: (...a: unknown[]) => unknown) => void }) {
  db.function("like", { varargs: true, deterministic: true }, (...a: unknown[]) => {
    const [pattern, value] = a as [string | null, string | null];
    if (pattern == null || value == null) return null;
    if (Buffer.byteLength(pattern) > 50) throw new Error("LIKE or GLOB pattern too complex");
    const re = new RegExp("^" + pattern.split("").map((ch) => (ch === "%" ? "[\\s\\S]*" : ch === "_" ? "[\\s\\S]" : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("") + "$", "i");
    return re.test(value) ? 1 : 0;
  });
}

async function verifiedDomain(c: Client, name: string) {
  const domainId = (await c.post("/api/domains", { name })).body.domain.id;
  const { body } = await c.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  await c.post(`/api/domains/${domainId}/verify`);
  return domainId;
}

let seq = 0;
async function mailTo(address: string, at: number) {
  await ctx.db.insert(messages).values({
    id: `msg_r99c${++seq}`, orgId: (await owner.get("/api/account/me")).body.organization.id, mailboxId, folder: "sent", threadId: `thr_r99c${seq}`,
    fromAddress: "team@acme.io", fromName: "Team", to: JSON.stringify([{ name: "", address }]), subject: `Quote ${seq}`, snippet: "hello", date: new Date(at),
  });
}

describe("R99 contact pages for long addresses (D1 LIKE limit)", () => {
  beforeAll(async () => {
    ctx = await makeTestApp({ CRM_TIMELINE: "on" });
    d1Like((ctx.db as unknown as { $client: Parameters<typeof d1Like>[0] }).$client);
    owner = new Client(ctx.app);
    await owner.signup("owner@acme.io", "Olive Owner");
    const domainId = await verifiedDomain(owner, "acme.io");
    mailboxId = (await owner.post("/api/mailboxes", { domainId, localPart: "team", displayName: "Team" })).body.mailbox.id;
    await mailTo(LONG, Date.UTC(2026, 9, 30));
    await mailTo(SHORT, Date.UTC(2026, 9, 29));
  });

  it("the test database now refuses long LIKE patterns, as D1 does", () => {
    expect(() => ctx.db.all(sql`select 1 where 'x' like ${"%" + "a".repeat(60) + "%"}`)).toThrow(/too complex/);
  });

  it("opens the contact page for a long address, with the mail sent to it", async () => {
    for (const email of [LONG, SHORT]) {
      const made = await owner.post("/api/contacts", { email });
      expect(made.status).toBe(201);
      const detail = await owner.get(`/api/contacts/${made.body.contact.id}`);
      expect(detail.status).toBe(200);
      expect(detail.body.threads.map((t: { subject: string }) => t.subject)).toEqual([email === LONG ? "Quote 1" : "Quote 2"]);
    }
  });

  it("the CRM timeline for that contact shows the mail too", async () => {
    const id = (await owner.get(`/api/contacts?q=subsidiary`)).body.contacts[0].id;
    const r = await owner.get(`/api/crm/timeline?type=contact&id=${id}&kinds=mail`);
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBe(1);
  });

  it("no server code builds a LIKE pattern around a JSON address", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(`${d}/${n}`).isDirectory() ? walk(`${d}/${n}`) : n.endsWith(".ts") && !n.includes("generated") ? [`${d}/${n}`] : []));
    const bad = walk("src/server").filter((f) => /`%"address":"\$\{/.test(readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });
});
