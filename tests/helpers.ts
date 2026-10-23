import { openSqlite } from "@/server/db/node";
import { migrate } from "@/server/db";
import { createApp } from "@/server/app";
import { loadConfig } from "@/server/config";
import { StaticResolver } from "@/server/services/dns/resolver";
import { LogOutbound } from "@/server/services/mail/outbound";
import type { Deps } from "@/server/context";

export async function makeTestApp(env: Record<string, string> = {}) {
  const db = openSqlite(":memory:");
  await migrate(db);
  const dns = new StaticResolver();
  const outbound = new LogOutbound();
  const deps: Deps = { db, config: loadConfig({ APP_SECRET: "t".repeat(40), ...env }), dns, outbound, now: () => new Date() };
  const app = createApp(deps);
  return { app, deps, db, dns, outbound };
}

/** A tiny cookie-keeping client over `app.request`. */
export class Client {
  cookie = "";
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
    const set = res.headers.get("set-cookie");
    if (set) {
      const m = set.match(/mm_session=([^;]*)/);
      if (m) this.cookie = m[1] ? `mm_session=${m[1]}` : "";
    }
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  }
  get(p: string) { return this.call("GET", p); }
  post(p: string, b: unknown = {}) { return this.call("POST", p, b); }
  patch(p: string, b: unknown) { return this.call("PATCH", p, b); }
  del(p: string) { return this.call("DELETE", p); }

  async signup(email = `user${Math.random().toString(36).slice(2, 8)}@example.com`, name = "Ada Lovelace") {
    const r = await this.post("/api/auth/signup", { name, email, password: "a-strong-password", organization: "Acme" });
    if (r.status !== 201) throw new Error(`signup failed: ${JSON.stringify(r.body)}`);
    return email;
  }
}
