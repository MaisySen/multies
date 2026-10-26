import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { v1Routes } from "@/server/routes/v1";

// The v1 app is built lazily (src/server/app.ts), so its routes are listed from v1Routes().
const allRoutes = (app: { routes: { method: string; path: string }[] }) => [
  ...app.routes,
  ...v1Routes().routes.map((r) => ({ method: r.method, path: `/api/v1${r.path === "/" ? "" : r.path}` })),
];

// Every API route, called with no session and no key. Only the public allowlist may answer
// 2xx, and nothing may answer 5xx. Found the v1 fields, guests and portfolio routes running
// without the API key check (500 instead of 401) in the round 9 QA pass.
const PUBLIC_OK = new Set([
  "GET /api/account/providers", "GET /api/config", "GET /api/health", "GET /api/status", "GET /api/v1/reference", "GET /api/v1/openapi.json",
  "POST /api/guest/signout", "POST /api/account/demo", "GET /api/fx",
  // RFC 7009: token revocation answers 200 even for an unknown token (it changes nothing then).
  "POST /api/oauth/revoke",
  // R30: browsers post CSP violation reports without credentials; it only logs and answers 204.
  "POST /api/csp-report", "GET /api/v1/reference.js",
  // R29b: the phone app reads its update policy before sign in (cached 60 s, no account data).
  "GET /api/v1/app-config",
]);

const fill = (path: string) => path.replace(/:[a-zA-Z]+(\{[^}]*\})?/g, "x1").replace(/\*$/, "x1");

describe("authorisation on every endpoint", () => {
  it("refuses guests (no session, no key) everywhere except the public routes, with no server errors", async () => {
    const { app } = await makeTestApp({ DEMO_MODE: "true" });
    const bad: string[] = [];
    let checked = 0;
    for (const r of allRoutes(app)) {
      if (r.method === "ALL" || !r.path.startsWith("/api")) continue;
      const key = `${r.method} ${r.path}`;
      const res = await app.request(fill(r.path), { method: r.method, headers: { "content-type": "application/json", host: "localhost", "x-forwarded-for": `10.9.${checked % 250}.1` }, body: ["GET", "HEAD"].includes(r.method) ? undefined : "{}" });
      checked++;
      if (res.status >= 500) bad.push(`${res.status} ${key}`);
      else if (res.status < 300 && !PUBLIC_OK.has(key)) bad.push(`${res.status} ${key}`);
    }
    expect(checked).toBeGreaterThan(300);
    expect(bad).toEqual([]);
  });

  it("keeps each workspace's records away from other workspaces", async () => {
    const { app } = await makeTestApp({ DEMO_MODE: "true" });
    const a = new Client(app);
    const b = new Client(app);
    expect((await a.post("/api/account/demo")).status).toBe(201);
    await b.signup("other@acme.io");
    await a.post("/api/account/demo/seed");
    const ids: Record<string, string> = {};
    const first = async (path: string, key: string) => {
      const body = (await a.get(path)).body;
      const list = Object.values(body).find((v) => Array.isArray(v)) as { id: string }[] | undefined;
      if (list?.[0]) ids[key] = list[0].id;
    };
    await Promise.all([
      first("/api/tasks", "tasks"), first("/api/contacts", "contacts"), first("/api/projects", "projects"), first("/api/docs", "docs"),
      first("/api/deals", "deals"), first("/api/agents", "agents"), first("/api/approvals?status=pending", "approvals"),
      first("/api/companies", "companies"), first("/api/automations", "automations"), first("/api/mailboxes", "mailboxes"), first("/api/domains", "domains"),
    ]);
    expect(Object.keys(ids).length).toBeGreaterThanOrEqual(8);
    const leaks: string[] = [];
    for (const [res, id] of Object.entries(ids)) {
      for (const [method, body] of [["GET", undefined], ["PATCH", { title: "x", name: "x" }], ["DELETE", undefined]] as const) {
        const r = await b.call(method, `/api/${res}/${id}`, body);
        if (r.status < 400 || r.status >= 500) leaks.push(`${r.status} ${method} /api/${res}/${id}`);
      }
    }
    expect(leaks).toEqual([]);
    // And the records are all still there for their owner.
    for (const [res, id] of Object.entries(ids)) {
      if (["approvals", "automations", "agents", "mailboxes", "domains", "companies", "deals"].includes(res)) continue;
      expect((await a.get(`/api/${res}/${id}`)).status).toBe(200);
    }
  });
});
