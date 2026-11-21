/**
 * R115 maps routes (MAPS_R115; 404 when off).
 *   GET    /api/maps/lookup?q=&mode=suggest|find   address lookup (cached, capped, 1 a second per service)
 *   GET    /api/maps/places?type=contact|company|scheduling_page&id=
 *   PUT    /api/maps/places                         { entityType, entityId, address, lat?, lon? }
 *   DELETE /api/maps/places?type=&id=
 *   GET    /api/maps/visits                         contacts and companies with an address
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { badRequest, notFound } from "../lib/errors";
import { getPlace, lookup, removePlace, setPlace, visitCandidates, type PlaceEntity } from "../services/maps-r115";
import { flagOn } from "../services/console/flag-gate"; // OPS1 feature flags

const ENTITIES = ["contact", "company", "scheduling_page"] as const;
const PlaceBody = z.object({
  entityType: z.enum(ENTITIES), entityId: z.string().min(1).max(64), address: z.string().max(300),
  lat: z.number().min(-90).max(90).nullable().optional(), lon: z.number().min(-180).max(180).nullable().optional(),
});
function entity(q: (k: string) => string | undefined): { type: PlaceEntity; id: string } {
  const type = q("type"), id = q("id") ?? "";
  if (!type || !(ENTITIES as readonly string[]).includes(type) || !id || id.length > 64) throw badRequest("Say which record the address belongs to.");
  return { type: type as PlaceEntity, id };
}

export function mapsRoutes() {
  return new Hono<AppEnv>()
    .use("*", async (c, next) => { if (!(await flagOn(c, "mapsR115"))) throw notFound("Page"); await next(); }) // OPS1: per workspace flag
    .use("*", requireAuth)
    .get("/lookup", async (c) => {
      const q = (c.req.query("q") ?? "").slice(0, 300);
      return c.json(await lookup(c.var.deps, c.var.auth, q, c.req.query("mode") === "find" ? "find" : "suggest"));
    })
    .get("/places", async (c) => { const e = entity((k) => c.req.query(k)); return c.json({ place: await getPlace(c.var.deps, c.var.auth, e.type, e.id) }); })
    .put("/places", async (c) => c.json({ place: await setPlace(c.var.deps, c.var.auth, await parseBody(c, PlaceBody)) }))
    .delete("/places", async (c) => { const e = entity((k) => c.req.query(k)); return c.json(await removePlace(c.var.deps, c.var.auth, e.type, e.id)); })
    .get("/visits", async (c) => c.json(await visitCandidates(c.var.deps, c.var.auth)));
}
