/**
 * OPS1: the role by permission matrix over every operator route that exists. The routes are read from the routers
 * themselves (each route's requireOperator guard carries its permission), so a route added later is covered without
 * editing this file, and a console route with no permission guard fails the first test.
 */
import { describe, expect, it, beforeAll } from "vitest";
import type { Hono } from "hono";
import { makeTestApp, Client } from "./helpers";
import { signUpAs, type Ctx } from "./console-kit";
import { consoleRoutes } from "@/server/routes/console";
import { adminRoutes } from "@/server/routes/admin";
import { adminReportsRoutes } from "@/server/routes/reports-r35";
import { adminAppConfigRoutes } from "@/server/routes/app-config-r29b";
import { OPERATOR_ROLES, ROLE_PERMISSIONS, can, type OperatorRole, type Permission } from "@/shared/operator-permissions";

interface Guarded { method: string; path: string; permission: Permission; stepUp: boolean }

/** Every method + path in a router with its requireOperator guard (or null when it has none). */
function routesOf(app: Hono<never> | Hono<any>, prefix = ""): { method: string; path: string; guard: { permission: Permission; stepUp: boolean } | null }[] { // eslint-disable-line @typescript-eslint/no-explicit-any
  const byKey = new Map<string, { method: string; path: string; guard: { permission: Permission; stepUp: boolean } | null }>();
  for (const r of app.routes) {
    if (r.method === "ALL") continue; // .use middleware (operatorSession)
    const path = `${prefix}${r.path}`.replace(/\/$/, "") || "/";
    const key = `${r.method} ${path}`;
    const entry = byKey.get(key) ?? { method: r.method, path, guard: null };
    const h = r.handler as unknown as { permission?: Permission; stepUp?: boolean };
    if (h.permission) entry.guard = { permission: h.permission, stepUp: !!h.stepUp };
    byKey.set(key, entry);
  }
  return [...byKey.values()];
}

const consoleList = routesOf(consoleRoutes());
const legacyList = [
  ...routesOf(adminAppConfigRoutes(), "/api/admin/app-config"),
  ...routesOf(adminReportsRoutes(), "/api/admin/reports"),
  ...routesOf(adminRoutes(), "/api/admin"),
];

describe("console routes all carry a permission", () => {
  it("every /api/console and /api/admin route has a requireOperator guard", () => {
    expect(consoleList.length).toBeGreaterThanOrEqual(7);
    const missing = [...consoleList, ...legacyList].filter((r) => !r.guard).map((r) => `${r.method} ${r.path}`);
    expect(missing).toEqual([]);
  });
  it("the matrix: read permissions for everyone, changes by tier, owner only at the top", () => {
    for (const role of OPERATOR_ROLES) expect(can(role, "console.view")).toBe(true);
    expect(can("ops_readonly", "workspaces.suspend")).toBe(false);
    expect(can("ops_support", "workspaces.suspend")).toBe(true);
    expect(can("ops_billing", "workspaces.suspend")).toBe(false);
    expect(can("ops_billing", "billing.manage")).toBe(true);
    expect(can("ops_support", "billing.manage")).toBe(false);
    expect(can("ops_support", "impersonation.view")).toBe(true);
    expect(can("ops_support", "impersonation.act")).toBe(false);
    expect(can("ops_admin", "impersonation.act")).toBe(true);
    expect(can("ops_admin", "operators.manage")).toBe(false);
    expect(can("admin", "operators.manage")).toBe(true);
    expect(can("user", "console.view")).toBe(false);
    expect(can(null, "console.view")).toBe(false);
  });
});

describe("console RBAC matrix", () => {
  let ctx: Ctx;
  const clients = {} as Record<OperatorRole | "customer", Client>;
  beforeAll(async () => {
    ctx = await makeTestApp();
    for (const role of OPERATOR_ROLES) clients[role] = (await signUpAs(ctx, `${role}@ops.test`, role)).c;
    clients.customer = (await signUpAs(ctx, "customer@else.test", null)).c;
  }, 60_000);

  const all: Guarded[] = [...consoleList, ...legacyList].flatMap((r) => (r.guard ? [{ method: r.method, path: r.path, ...r.guard }] : []));
  const fill = (p: string) => p.replace(/:[A-Za-z]+\??/g, "x_missing");

  it("anonymous callers get 401 and customers 403 on every operator route", async () => {
    const anon = new Client(ctx.app);
    for (const r of all) {
      const body = r.method === "GET" ? undefined : {};
      const a = await anon.call(r.method, fill(r.path), body);
      expect(a.status, `${r.method} ${r.path} anonymous`).toBe(401);
      const cu = await clients.customer.call(r.method, fill(r.path), body);
      expect(cu.status, `${r.method} ${r.path} customer`).toBe(403);
    }
  }, 120_000);

  for (const role of OPERATOR_ROLES) {
    it(`${role}: allowed routes pass the guard, the rest are 403 forbidden`, async () => {
      for (const r of all) {
        const allowed = ROLE_PERMISSIONS[role].has(r.permission);
        const res = await clients[role].call(r.method, fill(r.path), r.method === "GET" ? undefined : {});
        if (allowed) expect([401, 403], `${role} ${r.method} ${r.path} should pass (${r.permission}), got ${res.status} ${JSON.stringify(res.body)}`).not.toContain(res.status);
        else {
          expect(res.status, `${role} ${r.method} ${r.path} should be refused (${r.permission})`).toBe(403);
          expect(res.body.error.code).toBe("forbidden");
        }
      }
    }, 120_000);
  }
});
