import { openSqlite } from "@/server/db/node";
import { migrate } from "@/server/db";
import { createApp } from "@/server/app";
import { loadConfig } from "@/server/config";
import { StaticResolver } from "@/server/services/dns/resolver";
import { LogOutbound } from "@/server/services/mail/outbound";
import type { Deps } from "@/server/context";
import { nullLogger } from "@/server/lib/logger";

export async function makeTestApp(env: Record<string, string> = {}, opts: { fetch?: typeof fetch } = {}) {
  const db = openSqlite(":memory:");
  await migrate(db);
  const dns = new StaticResolver();
  const outbound = new LogOutbound();
  const fetchImpl = opts.fetch ?? (async () => { throw new Error("network disabled in tests"); });
  const deps: Deps = { db, config: loadConfig({ APP_SECRET: "t".repeat(40), ...env }), dns, outbound, now: () => new Date(), fetch: fetchImpl as typeof fetch, log: nullLogger };
  const app = createApp(deps);
  return { app, deps, db, dns, outbound };
}

/** A tiny cookie-keeping client over `app.request`. */
export class Client {
  jar = new Map<string, string>();
  get cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  set cookie(v: string) { this.jar.clear(); for (const part of v.split(/;\s*/).filter(Boolean)) { const i = part.indexOf("="); this.jar.set(part.slice(0, i), part.slice(i + 1)); } }
  constructor(private app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> }) {}

  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
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
