/**
 * R77: workspace branding (logo, colours, shape, font, default appearance) and each person's own theme.
 * Everyone in a workspace reads the brand; only owners and admins change it, and each change is audited.
 * Logos are public images (they appear on shared links and booking pages) served with a versioned URL.
 */
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { AppEnv } from "../context";
import type { DB } from "../db";
import { parseBody, requireAdmin, requireAuth } from "../middleware";
import { userThemes, workspaceBrandLogos, workspaceBranding } from "../db/schema";
import { audit } from "../services/audit";
import { HttpError, notFound } from "../lib/errors";
import { fromB64, toB64, toHex } from "../lib/crypto";
import {
  BrandPatchSchema, DEFAULT_PERSONAL, LOGO_KINDS, LOGO_MAX_BYTES, PersonalSchema, brandCss, checkBrand, readBrand, sniffImage,
  type Brand, type LogoKind, type Personal,
} from "@/shared/branding";

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; brand: Brand }>();
const isKind = (k: string): k is LogoKind => (LOGO_KINDS as string[]).includes(k);

/** The brand for a workspace, from a copy up to a minute old in this isolate (two primary key reads otherwise). */
export async function getBrand(db: DB, orgId: string, fresh = false): Promise<Brand> {
  const hit = cache.get(orgId);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.brand;
  const [row, logos] = await Promise.all([
    db.select({ brand: workspaceBranding.brand }).from(workspaceBranding).where(eq(workspaceBranding.orgId, orgId)).get(),
    db.select({ kind: workspaceBrandLogos.kind, version: workspaceBrandLogos.version }).from(workspaceBrandLogos).where(eq(workspaceBrandLogos.orgId, orgId)).all(),
  ]);
  const brand = readBrand(row?.brand, Object.fromEntries(logos.map((l) => [l.kind, l.version])));
  cache.set(orgId, { at: Date.now(), brand });
  if (cache.size > 500) cache.delete(cache.keys().next().value as string);
  return brand;
}

function stored(b: Brand): string {
  const { logos: _l, ...rest } = b;
  return JSON.stringify(rest);
}

async function personalFor(db: DB, userId: string, orgId: string): Promise<Personal> {
  const r = await db.select({ followBrand: userThemes.followBrand, accent: userThemes.accent }).from(userThemes)
    .where(and(eq(userThemes.userId, userId), eq(userThemes.orgId, orgId))).get();
  return r ? { followBrand: r.followBrand, accent: r.accent } : DEFAULT_PERSONAL;
}

/** Public fields only: what a shared link or booking page needs to paint the workspace's look. */
export function publicBrand(b: Brand) {
  return { primary: b.primary, accent: b.accent, radius: b.radius, font: b.font, logos: b.logos };
}

export function brandingRoutes() {
  return new Hono<AppEnv>()
    // The public logo image. The version in the path changes with the bytes, so it is cached for good.
    .get("/logo/:orgId/:kind/:version", async (c) => {
      const { orgId, kind, version } = c.req.param();
      if (!isKind(kind) || !/^[\w-]{1,64}$/.test(orgId)) throw notFound("No such logo.");
      const r = await c.var.deps.db.select().from(workspaceBrandLogos).where(and(eq(workspaceBrandLogos.orgId, orgId), eq(workspaceBrandLogos.kind, kind))).get();
      if (!r) throw notFound("No such logo.");
      const bytes = fromB64(r.contentB64);
      return new Response(bytes, { headers: {
        "content-type": r.contentType,
        "cache-control": r.version === version ? "public, max-age=31536000, immutable" : "public, max-age=300",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cross-origin-resource-policy": "cross-origin",
      } });
    })
    .get("/", requireAuth, async (c) => {
      const { auth, deps } = c.var;
      const [brand, personal] = await Promise.all([getBrand(deps.db, auth.orgId), personalFor(deps.db, auth.userId, auth.orgId)]);
      return c.json({ orgId: auth.orgId, brand, personal, canEdit: auth.role !== "member", css: brandCss(brand, personal), checks: checkBrand(brand) });
    })
    .put("/", requireAuth, requireAdmin, async (c) => {
      const patch = await parseBody(c, BrandPatchSchema);
      const { auth, deps } = c.var;
      const before = await getBrand(deps.db, auth.orgId, true);
      const next: Brand = { ...before, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
      const now = deps.now();
      await deps.db.insert(workspaceBranding).values({ orgId: auth.orgId, brand: stored(next), updatedBy: auth.userId, updatedAt: now })
        .onConflictDoUpdate({ target: workspaceBranding.orgId, set: { brand: stored(next), updatedBy: auth.userId, updatedAt: now } });
      const changed = Object.keys(patch).filter((k) => JSON.stringify((before as unknown as Record<string, unknown>)[k]) !== JSON.stringify((next as unknown as Record<string, unknown>)[k]));
      if (changed.length) await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "workspace.branding_changed", targetType: "workspace", targetId: auth.orgId, metadata: { changed, ...Object.fromEntries(changed.map((k) => [k, (next as unknown as Record<string, unknown>)[k]])) }, ip: c.var.ip });
      cache.set(auth.orgId, { at: Date.now(), brand: next });
      return c.json({ brand: next, css: brandCss(next, await personalFor(deps.db, auth.userId, auth.orgId)), checks: checkBrand(next) });
    })
    // Reset to Multies' own look: the brand row and every logo go.
    .delete("/", requireAuth, requireAdmin, async (c) => {
      const { auth, deps } = c.var;
      await deps.db.delete(workspaceBranding).where(eq(workspaceBranding.orgId, auth.orgId));
      await deps.db.delete(workspaceBrandLogos).where(eq(workspaceBrandLogos.orgId, auth.orgId));
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "workspace.branding_reset", targetType: "workspace", targetId: auth.orgId, ip: c.var.ip });
      cache.delete(auth.orgId);
      const brand = await getBrand(deps.db, auth.orgId, true);
      return c.json({ brand, css: brandCss(brand, await personalFor(deps.db, auth.userId, auth.orgId)), checks: checkBrand(brand) });
    })
    // A logo upload: the raw image bytes as the body (PNG, JPEG or WebP, 512 KB at most).
    .put("/logo/:kind", requireAuth, requireAdmin, async (c) => {
      const kind = c.req.param("kind");
      if (!isKind(kind)) throw notFound("No such logo slot.");
      const len = Number(c.req.header("content-length") ?? 0);
      if (len > LOGO_MAX_BYTES) throw new HttpError(413, "too_large", "Logos can be up to 512 KB. Try a smaller PNG or WebP.");
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (!bytes.byteLength) throw new HttpError(422, "validation_failed", "Choose an image file.");
      if (bytes.byteLength > LOGO_MAX_BYTES) throw new HttpError(413, "too_large", "Logos can be up to 512 KB. Try a smaller PNG or WebP.");
      const type = sniffImage(bytes);
      if (!type) throw new HttpError(422, "unsupported_type", "Use a PNG, JPEG or WebP image.");
      const { auth, deps } = c.var;
      const version = toHex(await crypto.subtle.digest("SHA-256", bytes)).slice(0, 12);
      const now = deps.now();
      const row = { contentType: type, sizeBytes: bytes.byteLength, version, contentB64: toB64(bytes), updatedAt: now };
      await deps.db.insert(workspaceBrandLogos).values({ orgId: auth.orgId, kind, ...row })
        .onConflictDoUpdate({ target: [workspaceBrandLogos.orgId, workspaceBrandLogos.kind], set: row });
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "workspace.logo_changed", targetType: "workspace", targetId: auth.orgId, metadata: { kind, bytes: bytes.byteLength, type }, ip: c.var.ip });
      const brand = await getBrand(deps.db, auth.orgId, true);
      return c.json({ brand });
    })
    .delete("/logo/:kind", requireAuth, requireAdmin, async (c) => {
      const kind = c.req.param("kind");
      if (!isKind(kind)) throw notFound("No such logo slot.");
      const { auth, deps } = c.var;
      await deps.db.delete(workspaceBrandLogos).where(and(eq(workspaceBrandLogos.orgId, auth.orgId), eq(workspaceBrandLogos.kind, kind)));
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "workspace.logo_removed", targetType: "workspace", targetId: auth.orgId, metadata: { kind }, ip: c.var.ip });
      const brand = await getBrand(deps.db, auth.orgId, true);
      return c.json({ brand });
    })
    // A person's own theme in this workspace.
    .put("/me", requireAuth, async (c) => {
      const p = await parseBody(c, PersonalSchema);
      const { auth, deps } = c.var;
      const now = deps.now();
      await deps.db.insert(userThemes).values({ userId: auth.userId, orgId: auth.orgId, followBrand: p.followBrand, accent: p.accent, updatedAt: now })
        .onConflictDoUpdate({ target: [userThemes.userId, userThemes.orgId], set: { followBrand: p.followBrand, accent: p.accent, updatedAt: now } });
      const brand = await getBrand(deps.db, auth.orgId);
      return c.json({ personal: p, css: brandCss(brand, p), locked: brand.locked });
    });
}
