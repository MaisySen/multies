import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { HttpError } from "../lib/errors";
import { rateLimit } from "../lib/rate-limit";
import { decideMnet, exchangeMnet, listMnet, mnetRequest, mnetProof, prepareMnet, revokeMnet, mnetLaunch, mnetLaunchInfo, ownMnetDevices, mnetCheck, checkMnet } from "../services/mnet";

async function body<T>(c: { req: { raw: Request } }, schema: z.ZodType<T>): Promise<T> {
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new HttpError(400, "invalid_request", "Mnet request is invalid.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) { await reader.cancel(); throw new Error("oversize"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch { throw new HttpError(400, "invalid_request", "Mnet request is invalid."); }
  finally { reader.releaseLock(); }
}
export function mnetRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    c.header("Referrer-Policy", "no-referrer");
    if (!c.var.deps.config.mnetDeviceBridge) return c.json({ error: { code: "not_found", message: "Not found." } }, 404);
    await next();
  });
  r.use("*", rateLimit("handoff", (c) => `mnet:${c.var.ip}`, { countReads: true }));
  r.get("/authorize", async (c) => {
    const parsed = mnetLaunch.safeParse(c.req.query());
    if (!parsed.success || Object.keys(c.req.query()).some((key) => c.req.queries(key)!.length !== 1)) throw new HttpError(400, "invalid_request", "Mnet sign in link is invalid.");
    return c.json(await mnetLaunchInfo(c.var.deps, c.req.raw.headers, parsed.data));
  });
  r.post("/authorizations", async (c) => c.json(await prepareMnet(c.var.deps, c.req.raw.headers, await body(c, mnetRequest)), 201));
  r.post("/authorizations/:id/decision", async (c) => {
    const decision = await body(c, z.object({ decision: z.enum(["allow", "decline"]) }).strict());
    return c.json(await decideMnet(c.var.deps, c.req.raw.headers, c.req.param("id"), decision.decision === "allow"));
  });
  r.post("/token", async (c) => {
    // Native proof exchange never accepts or emits browser-session cookies.
    if (c.req.header("cookie") || c.req.header("origin")) throw new HttpError(403, "mnet_denied", "Mnet access is unavailable.");
    return c.json(await exchangeMnet(c.var.deps, await body(c, mnetProof)));
  });
  r.post("/check", async (c) => {
    if (c.req.header("cookie") || c.req.header("origin")) throw new HttpError(403, "mnet_denied", "Mnet access is unavailable.");
    return c.json(await checkMnet(c.var.deps, c.req.header("authorization")?.replace(/^Bearer /, "") ?? "", await body(c, mnetCheck)));
  });
  r.get("/approved-devices", async (c) => c.json(await ownMnetDevices(c.var.deps, c.req.raw.headers)));
  r.get("/devices", async (c) => c.json(await listMnet(c.var.deps, c.req.header("authorization")?.replace(/^Bearer /, "") ?? "")));
  r.delete("/devices/:id", async (c) => c.json(await revokeMnet(c.var.deps, c.req.raw.headers, c.req.param("id"))));
  return r;
}
