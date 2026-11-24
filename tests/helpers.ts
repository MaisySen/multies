import { openSqlite } from "@/server/db/node";
import { migrate, migrateIndex } from "@/server/db";
import { createApp } from "@/server/app";
import { loadConfig } from "@/server/config";
import { StaticResolver } from "@/server/services/dns/resolver";
import { LogOutbound } from "@/server/services/mail/outbound";
import type { Deps } from "@/server/context";
import { nullLogger } from "@/server/lib/logger";
import { users } from "@/server/db/schema";
import { eq } from "drizzle-orm";

/**
 * R39: the test database behind each app, so a Client can confirm its own address before it accepts an
 * invite. In production every account signs in through the identity provider with a confirmed address,
 * and accepting an invite now needs one. Set client.autoVerify = false to test an unconfirmed account.
 */
const appDbs = new WeakMap<object, Deps["db"]>();

/**
 * D1 refuses a statement with more than 100 bound variables ("too many SQL variables"); SQLite in tests takes
 * 32,766. This makes the test database refuse the same statements, so an unchunked IN list fails here, not in prod.
 */
export const D1_MAX_VARIABLES = 100;
/** Every refused statement, so a sweep can name all of them at once. */
export const d1Violations: string[] = [];
export function enforceD1VariableLimit(db: ReturnType<typeof openSqlite>) {
  const client = (db as unknown as { $client: { prepare: (sql: string) => unknown } }).$client;
  const prepare = client.prepare.bind(client);
  client.prepare = (sql: string) => {
    const vars = (sql.replace(/'(?:[^']|'')*'/g, "").match(/\?/g) ?? []).length;
    if (vars > D1_MAX_VARIABLES) d1Violations.push(`${vars} vars: ${sql.replace(/\(\?(, \?)+\)/g, "(?...)").slice(0, 700)}`);
    if (vars > D1_MAX_VARIABLES) throw new Error(`too many SQL variables (${vars} > ${D1_MAX_VARIABLES}): ${sql.slice(0, 120)}`);
    return prepare(sql);
  };
}

export async function makeTestApp(env: Record<string, string> = {}, opts: { fetch?: typeof fetch; noIndexDb?: boolean } = {}) {
  const db = openSqlite(":memory:");
  await migrate(db);
  // Tools P2 (17): the separate attachment text index database, as INDEX_DB is on Workers.
  const indexDb = opts.noIndexDb ? undefined : openSqlite(":memory:");
  if (indexDb) await migrateIndex(indexDb);
  enforceD1VariableLimit(db);
  const dns = new StaticResolver();
  const outbound = new LogOutbound();
  const fetchImpl = opts.fetch ?? (async () => { throw new Error("network disabled in tests"); });
  // Round 2: tests stand behind a trusted proxy (TRUST_PROXY), so a client's CF-Connecting-IP names its address, and per
  // address limits can be tested. Wave 1 review V9: only the configured header counts (TRUST_PROXY_HEADER); tests use
  // CF-Connecting-IP. tests/client-ip-r2.test.ts covers TRUST_PROXY off and the X-Forwarded-For default.
  const deps: Deps = { db, indexDb, config: loadConfig({ APP_SECRET: "t".repeat(40), TRUST_PROXY: "true", TRUST_PROXY_HEADER: "cf-connecting-ip", ...env }), dns, outbound, now: () => new Date(), fetch: fetchImpl as typeof fetch, log: nullLogger };
  const app = createApp(deps);
  appDbs.set(app, db);
  return { app, deps, db, indexDb, dns, outbound };
}

/** A tiny cookie-keeping client over `app.request`. */
export class Client {
  jar = new Map<string, string>();
  get cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  set cookie(v: string) { this.jar.clear(); for (const part of v.split(/;\s*/).filter(Boolean)) { const i = part.indexOf("="); this.jar.set(part.slice(0, i), part.slice(i + 1)); } }
  /** The address this client signed up or signed in with. */
  email: string | null = null;
  /** Confirm the address just before accepting an invite (see appDbs above). */
  autoVerify = true;
  constructor(private app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> }) {}

  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    if (method === "POST" && /^\/api\/auth\/sign-(up|in)\/email$/.test(path) && body && typeof (body as { email?: unknown }).email === "string") {
      this.email = ((body as { email: string }).email).toLowerCase();
    }
    if (this.autoVerify && this.email && method === "POST" && /^\/api\/invites\/[^/]+\/accept$/.test(path)) {
      const db = appDbs.get(this.app);
      if (db) await db.update(users).set({ emailVerified: true }).where(eq(users.email, this.email));
    }
    const res = await this.app.request(path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        host: "localhost",
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(/;\s*/);
      const i = pair.indexOf("=");
      const name = pair.slice(0, i), value = pair.slice(i + 1);
      const expired = !value || attrs.some((a) => /^max-age=0$/i.test(a));
      if (expired) this.jar.delete(name); else this.jar.set(name, value);
    }
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let json: any;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  }
  get(p: string) { return this.call("GET", p); }
  post(p: string, b: unknown = {}) { return this.call("POST", p, b); }
  patch(p: string, b: unknown) { return this.call("PATCH", p, b); }
  put(p: string, b: unknown) { return this.call("PUT", p, b); }
  del(p: string) { return this.call("DELETE", p); }

  /** Signs up through Better Auth and names the personal workspace "Acme". */
  async signup(email = `user${Math.random().toString(36).slice(2, 8)}@example.com`, name = "Ada Lovelace", organization = "Acme") {
    const r = await this.post("/api/auth/sign-up/email", { name, email, password: "a-strong-password" });
    if (r.status !== 200) throw new Error(`signup failed: ${r.status} ${JSON.stringify(r.body)}`);
    const me = await this.get("/api/account/me");
    if (me.status !== 200) throw new Error(`me failed: ${JSON.stringify(me.body)}`);
    if (organization) await this.patch("/api/org", { name: organization });
    return email;
  }
  login(email: string, password = "a-strong-password") {
    return this.post("/api/auth/sign-in/email", { email, password });
  }
}
