import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { HttpError } from "../lib/errors";
import { rateLimit } from "../lib/rate-limit";
import { body } from "./mnet";
import { handoffConfig, handoffLaunch, handoffRequest, handoffExchange, handoffInfo, prepareHandoff, decideHandoff, exchangeHandoff } from "../services/mnet-enrollment-handoff";

export function mnetEnrollmentHandoffRoutes() {
 const r = new Hono<AppEnv>();
 r.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store"); c.header("Pragma", "no-cache"); c.header("Referrer-Policy", "no-referrer");
  handoffConfig(c.var.deps); await next();
 });
 r.use("*", rateLimit("handoff", (c) => `mnet-enrollment-v1:${c.var.ip}`, { countReads: true }));
 r.get("/authorize", async (c) => {
  const query = c.req.query();
  const p = handoffLaunch.safeParse({ ...query, version: query.version === "1" ? 1 : query.version });
  // URL query values are strings; version is a fixed literal on this endpoint.
  if (!p.success || Object.keys(c.req.query()).some((key) => c.req.queries(key)!.length !== 1)) throw new HttpError(400, "invalid_request", "Computer joining request is invalid.");
  return c.json(await handoffInfo(c.var.deps, c.req.raw.headers, p.data));
 });
 r.post("/authorizations", async (c) => c.json(await prepareHandoff(c.var.deps, c.req.raw.headers, await body(c, handoffRequest)), 201));
 r.post("/authorizations/:id/decision", async (c) => {
  const p = await body(c, z.object({ decision: z.enum(["allow", "decline"]) }).strict());
  return c.json(await decideHandoff(c.var.deps, c.req.raw.headers, c.req.param("id"), p.decision === "allow"));
 });
 r.post("/exchange", async (c) => {
  if (c.req.header("cookie") || c.req.header("origin") || c.req.header("authorization")) throw new HttpError(403, "mnet_enrollment_denied", "Computer joining handoff is unavailable.");
  return c.json(await exchangeHandoff(c.var.deps, await body(c, handoffExchange)));
 });
 r.post("/exchange-v2",async(c)=>{
  if(c.req.header("cookie")||c.req.header("origin")||c.req.header("authorization"))throw new HttpError(403,"mnet_enrollment_denied","Computer joining handoff is unavailable.");
  return c.json(await exchangeHandoff(c.var.deps,await body(c,handoffExchange),2));
 });
 // No proof/consume/native-recovery/node route exists.
 return r;
}
