import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { HttpError } from "../lib/errors";
import { rateLimit } from "../lib/rate-limit";
import { body } from "./mnet";
import { enrollmentOperatorSchema } from "../services/mnet-enrollment-config";
import { enrollmentLaunch, enrollmentRequest, enrollmentInfo, prepareEnrollment, decideEnrollment } from "../services/mnet-enrollment";

export function mnetEnrollmentRoutes() {
 const r = new Hono<AppEnv>();
 r.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store"); c.header("Pragma", "no-cache"); c.header("Referrer-Policy", "no-referrer");
  if (!c.var.deps.config.mnetEnrollmentConsent || !enrollmentOperatorSchema.safeParse(c.var.deps.config.mnetEnrollmentOperator).success) return c.json({ error: { code: "not_found", message: "Not found." } }, 404);
  await next();
 });
 r.use("*", rateLimit("handoff", (c) => `mnet-enrollment:${c.var.ip}`, { countReads: true }));
 r.get("/authorize", async (c) => {
  const parsed = enrollmentLaunch.safeParse(c.req.query());
  if (!parsed.success || Object.keys(c.req.query()).some((key) => c.req.queries(key)!.length !== 1)) throw new HttpError(400, "invalid_request", "Computer joining request is invalid.");
  return c.json(await enrollmentInfo(c.var.deps, c.req.raw.headers, parsed.data));
 });
 r.post("/decisions", async (c) => c.json(await prepareEnrollment(c.var.deps, c.req.raw.headers, await body(c, enrollmentRequest)), 201));
 r.post("/decisions/:id", async (c) => {
  const decision = await body(c, z.object({ decision: z.enum(["allow", "decline"]) }).strict());
  return c.json(await decideEnrollment(c.var.deps, c.req.raw.headers, c.req.param("id"), decision.decision === "allow"));
 });
 // No ticket, consume, recovery or node route. Consent records cannot be redeemed.
 return r;
}
