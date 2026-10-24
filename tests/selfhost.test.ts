import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import { makeTestApp, Client } from "./helpers";
import { handleHook, parseKeys, rawFromHook, signDelivery, type HookRequest } from "../scripts/selfhost/mail-bridge";
import { sign as workerSign } from "../email-worker/src/index";
import { backup, cleanD1Dump, importDump, restore, summary } from "../scripts/selfhost/db-tool";
import { hookObject, relayExpr, senderExpr } from "../scripts/selfhost/stalwart";
import { SmtpOutbound, isRetryable, smtpSettingsFrom } from "../src/entry/smtp-outbound";
import { openSqlite } from "@/server/db/node";
import { migrate } from "@/server/db";

function hook(o: { to?: string[]; subject?: string; login?: string } = {}): HookRequest {
  return {
    context: { stage: "DATA", sasl: o.login ? { login: o.login } : null },
    envelope: { from: { address: "grace@navy.mil" }, to: (o.to ?? ["hello@acme.io"]).map((address) => ({ address })) },
    message: {
      serverHeaders: [["Received", " from mx.navy.mil by mail.acme.io (Stalwart) with ESMTPS"]],
      headers: [["From", " Grace Hopper <grace@navy.mil>"], ["To", "hello@acme.io"], ["Subject", ` ${o.subject ?? "Through Stalwart"}`], ["Message-ID", ` <${Math.random().toString(36).slice(2)}@navy.mil>`], ["Content-Type", " text/plain; charset=utf-8"]],
      contents: "Hello from the mail bridge.\r\n",
    },
  };
}

describe("self-host mail bridge", () => {
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  let c: Client;
  let inboxId: string;
  let appFetch: typeof fetch;

  beforeEach(async () => {
    ctx = await makeTestApp();
    c = new Client(ctx.app);
    await c.signup();
    const domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
    inboxId = (await c.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Acme Hello" })).body.mailbox.id;
    appFetch = ((url: string, init: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...(init.headers as Record<string, string>), host: "localhost" } })) as unknown as typeof fetch;
  });

  it("signs exactly like the Cloudflare Email Worker", async () => {
    const body = new TextEncoder().encode("Subject: x\r\n\r\nhi");
    const ours = signDelivery("whsec_abc", "1700000000", "A@x.com", "B@y.com", body);
    expect(ours).toBe(await workerSign("whsec_abc", "1700000000", "A@x.com", "B@y.com", body.buffer));
  });

  it("rebuilds the raw message from Stalwart's headers and body", () => {
    const raw = rawFromHook(hook()).toString("utf8");
    expect(raw.startsWith("Received: from mx.navy.mil")).toBe(true);
    expect(raw).toContain("\r\nTo: hello@acme.io\r\n");
    expect(raw).toContain("\r\n\r\nHello from the mail bridge.\r\n");
  });

  it("delivers mail Stalwart received into the MyMail inbox and tells Stalwart to keep no copy", async () => {
    const key = (await c.post("/api/inbound-keys")).body.key;
    const out = await handleHook(hook(), { inboundUrl: "http://localhost/api/inbound/cloudflare", keys: [{ id: key.id, secret: key.secret }], fetch: appFetch });
    expect(out.action).toBe("discard");
    const list = await c.get(`/api/mail/messages?mailboxId=${inboxId}&folder=inbox`);
    expect(list.body.messages).toHaveLength(1);
    expect(list.body.messages[0]).toMatchObject({ subject: "Through Stalwart", from: { address: "grace@navy.mil" } });
  });

  it("tries each workspace's key and rejects unknown recipients with MyMail's reason", async () => {
    const other = new Client(ctx.app);
    await other.signup();
    const wrong = (await other.post("/api/inbound-keys")).body.key;
    const right = (await c.post("/api/inbound-keys")).body.key;
    const keys = parseKeys(`${wrong.id}:${wrong.secret}, ${right.id}:${right.secret}`);
    expect((await handleHook(hook(), { inboundUrl: "http://localhost/api/inbound/cloudflare", keys, fetch: appFetch })).action).toBe("discard");
    const nobody = await handleHook(hook({ to: ["nobody@acme.io"] }), { inboundUrl: "http://localhost/api/inbound/cloudflare", keys, fetch: appFetch });
    expect(nobody).toMatchObject({ action: "reject", response: { status: 550 } });
    expect(nobody.response?.message).toMatch(/No mailbox/);
  });

  it("asks the sender to retry when MyMail is down or no key is set, and never relays unauthenticated mail", async () => {
    const down = (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await handleHook(hook(), { inboundUrl: "http://mymail:8787/api/inbound/cloudflare", keys: [{ id: "k", secret: "s" }], fetch: down })).toMatchObject({ action: "reject", response: { status: 451 } });
    expect(await handleHook(hook(), { inboundUrl: "http://localhost/api/inbound/cloudflare", keys: [], fetch: appFetch })).toMatchObject({ action: "reject", response: { status: 451 } });
    const forged = await handleHook(hook({ to: ["someone@gmail.com"] }), { inboundUrl: "http://localhost/api/inbound/cloudflare", keys: [{ id: "nope", secret: "nope" }], fetch: appFetch });
    expect(forged.action).not.toBe("accept");
    expect((await handleHook(hook({ login: "ada@acme.io" }), { inboundUrl: "unused", keys: [] })).action).toBe("accept");
  });
});

describe("self-host Stalwart wiring", () => {
  it("only hooks sessions that are not signed in, and lets only MyMail's account send as others", () => {
    const h = hookObject("http://mail-bridge:8025/hook", "t".repeat(30));
    expect(h.enable.match[0].if).toBe("is_empty(authenticated_as)");
    expect(h.tempFailOnError).toBe(true);
    expect(relayExpr.else).toBe("!is_empty(authenticated_as)");
    expect(senderExpr("MyMail-Relay@ops.mymail.local").match[0].if).toBe("authenticated_as == 'mymail-relay@ops.mymail.local'");
    expect(() => senderExpr("x' || true || '")).toThrow();
  });
});

describe("self-host database tool", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "mymail-selfhost-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A dump in the shape `wrangler d1 export` writes: PRAGMA, CREATE TABLE, INSERT, Cloudflare's own tables. */
  async function d1Dump(): Promise<string> {
    const src = path.join(dir, "src.db");
    const db = openSqlite(src);
    await migrate(db);
    const raw = (db as unknown as { $client: Database.Database }).$client;
    raw.prepare("INSERT INTO users (id, email, name, email_verified, created_at, updated_at) VALUES ('u1', 'ada@acme.io', 'Ada', 1, 0, 0)").run();
    const lines = ["PRAGMA defer_foreign_keys=TRUE;", 'CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB);', "INSERT INTO _cf_KV VALUES('x', 'y');"];
    const tables = raw.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string; sql: string }[];
    for (const t of tables) {
      lines.push(`${t.sql};`);
      for (const row of raw.prepare(`SELECT * FROM "${t.name}"`).all() as Record<string, unknown>[]) {
        const vals = Object.values(row).map((v) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`));
        lines.push(`INSERT INTO "${t.name}" VALUES(${vals.join(",")});`);
      }
    }
    for (const i of raw.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all() as { sql: string }[]) lines.push(`${i.sql};`);
    raw.close();
    return lines.join("\n");
  }

  it("drops Cloudflare's internal tables from a D1 export", () => {
    const out = cleanD1Dump("PRAGMA defer_foreign_keys=TRUE;\nCREATE TABLE _cf_KV (k);\nINSERT INTO _cf_KV VALUES(1);\nCREATE TABLE users (id);\nINSERT INTO \"users\" VALUES(1);");
    expect(out).not.toContain("_cf_KV");
    expect(out).toContain("CREATE TABLE users");
  });

  it("imports a D1 export, keeps the old database, backs up online and restores", async () => {
    const sql = path.join(dir, "export.sql");
    writeFileSync(sql, await d1Dump());
    const live = path.join(dir, "mymail.db");
    writeFileSync(live, "");
    const r = await importDump(sql, live);
    expect(r.applied).toEqual([]);
    expect(r.kept && existsSync(r.kept)).toBe(true);
    const rows = Object.fromEntries(summary(live).map((t) => [t.table, t.rows]));
    expect(rows.users).toBe(1);
    expect(rows._cf_KV).toBeUndefined();

    const copy = path.join(dir, "backup.db");
    expect(await backup(live, copy)).toBeGreaterThan(0);
    const db = new Database(live);
    db.prepare("DELETE FROM users").run();
    db.close();
    restore(copy, live);
    expect(Object.fromEntries(summary(live).map((t) => [t.table, t.rows])).users).toBe(1);
    expect(readdirSync(dir).filter((f) => f.startsWith("mymail.db.before-")).length).toBeGreaterThanOrEqual(1);
  });
});

describe("SMTP sending for self-hosted installs", () => {
  it("reads SMTP settings and signs with the domain's DKIM key", async () => {
    expect(smtpSettingsFrom({})).toBeUndefined();
    expect(smtpSettingsFrom({ SMTP_HOST: "stalwart", SMTP_PORT: "465" })).toMatchObject({ host: "stalwart", port: 465, secure: true, allowSelfSigned: false });
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    let sent = "";
    const spy = { sendMail: async (m: object) => { const info = await transport.sendMail(m); sent = (info.message as Buffer).toString(); return info; } } as unknown as Transporter;
    const out = new SmtpOutbound({ host: "x", port: 587, secure: false, allowSelfSigned: true }, async (d) => (d === "acme.io" ? { domainName: d, keySelector: "mymail", privateKey } : undefined), spy);
    const res = await out.send({ from: { address: "hello@acme.io", name: "Acme" }, to: ["bob@example.com"], subject: "Hi", text: "Hello", messageId: "<m1@acme.io>" });
    expect(res).toMatchObject({ provider: "smtp", status: "sent" });
    expect(sent).toMatch(/DKIM-Signature: .*d=acme\.io/);
    expect(sent).toMatch(/s=mymail/);
    expect(isRetryable({ responseCode: 451 })).toBe(true);
    expect(isRetryable({ responseCode: 550 })).toBe(false);
  });
});
