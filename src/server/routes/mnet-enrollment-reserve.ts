import { Hono } from "hono";
import type { AppEnv } from "../context";
import { DbRateLimitStore } from "../lib/rate-limit";
import { body } from "./mnet";
import { authenticateEnrollmentService, enrollmentServiceConfig, reserveEnrollment, reserveRequest } from "../services/mnet-enrollment-reserve";
export function mnetEnrollmentReserveRoutes(){
 const r=new Hono<AppEnv>();
 r.use("*",async(c,next)=>{
  c.header("Cache-Control","no-store");c.header("Pragma","no-cache");c.header("Referrer-Policy","no-referrer");
  const config=enrollmentServiceConfig(c.var.deps);
  // Dedicated local fixture budget, separate from handoff. Global app300/min
  // still stacks. No unsupported production/Cloudflare binding assumption.
  const store=new DbRateLimitStore(()=>c.var.deps.db,()=>c.var.deps.now().getTime());
  const count=await store.increment(`enrollment-service-fixture:${c.var.ip}`);
  if(count.totalHits>config.requestsPerMinute){c.header("Retry-After","60");return c.json({error:{code:"rate_limited",message:"Too many requests."}},429);}
  await next();
 });
 r.post("/reserve",async(c)=>{
  const service=await authenticateEnrollmentService(c.var.deps,c.req.raw.headers);
  // Auth precedes reading/parsing body, ticket lookup and reservation mutation.
  const p=await body(c,reserveRequest);
  return c.json(await reserveEnrollment(c.var.deps,service,p));
 });
 // No status/ack/consume/reconciliation/native-recovery path.
 return r;
}
