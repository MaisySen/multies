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
