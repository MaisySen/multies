/** OPS1: shared setup for the operator console tests. */
import { eq } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { users } from "@/server/db/schema";
import type { OperatorRole } from "@/shared/operator-permissions";

let ipSeq = 0;

export type Ctx = Awaited<ReturnType<typeof makeTestApp>>;

/** Signs up a confirmed account and gives it a platform role (or none). Returns the client and its user id. */
export async function signUpAs(ctx: Ctx, email: string, role: OperatorRole | null, workspace = email.split("@")[0]) {
  const c = new Client(ctx.app);
  // Each sign up from its own address: Better Auth allows 5 sign ups a minute from one.
  const r = await c.call("POST", "/api/auth/sign-up/email", { name: "Op Erator", email, password: "a-strong-password" }, { "cf-connecting-ip": `198.51.100.${++ipSeq % 250}` });
  if (r.status !== 200) throw new Error(`signup failed: ${r.status} ${JSON.stringify(r.body)}`);
  if ((await c.get("/api/account/me")).status !== 200) throw new Error("me failed");
  if (workspace) await c.patch("/api/org", { name: workspace });
  await ctx.db.update(users).set({ emailVerified: true, ...(role ? { role } : {}) }).where(eq(users.email, email));
  const id = (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, email)).get())!.id;
  return { c, id };
}

/**
 * OPS1 security review (M1): asserts a console list answer's nextCursor carries only values its items show: the
 * cursor's id is an item's id and its sort value equals a value in that item (a date compares as epoch ms). A cursor
 * that carries a hidden or masked value (a raw webhook URL, a hash) fails. No nextCursor passes.
 */
export function assertCursorFromItems(body: { items: Record<string, unknown>[]; nextCursor: string | null }): void {
  if (!body.nextCursor) return;
  const raw = Buffer.from(body.nextCursor.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
  const cur = JSON.parse(raw) as { v: unknown; t?: string; id: unknown };
  const item = body.items.find((i) => i.id === cur.id);
  if (!item) throw new Error(`nextCursor id ${String(cur.id)} is not an item on the page`);
  const seen = new Set<string>();
  const walk = (x: unknown) => {
    if (x === null || x === undefined) return;
    if (typeof x === "string") {
      seen.add(x);
      if (/^\d{4}-\d{2}-\d{2}T/.test(x)) { const ms = Date.parse(x); if (Number.isFinite(ms)) seen.add(String(ms)); }
      return;
    }
    if (typeof x === "number" || typeof x === "boolean") { seen.add(String(x)); return; }
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (typeof x === "object") Object.values(x as Record<string, unknown>).forEach(walk);
  };
  walk(item);
  const v = String(cur.v);
  // Text sorts may compare in lower case; the item shows the value either way.
  if (!seen.has(v) && ![...seen].some((s) => s.toLowerCase() === v.toLowerCase())) {
    throw new Error(`nextCursor carries ${JSON.stringify(cur.v)}, which item ${String(cur.id)} does not show: ${raw}`);
  }
}
