import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { THEME_SCRIPT } from "@/server/lib/security-headers";
import {
  BrandPatchSchema, DEFAULT_BRAND, PRESETS, brandCss, checkBrand, colourTokens, contrast, ensureContrast, paletteFromPixels,
  logoScheme, pickLogo, readBrand, readableOn, sidebarTokens, sniffImage, type Brand,
} from "@/shared/branding";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);

async function setup() {
  const { app, deps } = await makeTestApp();
  const c = new Client(app);
  await c.signup(undefined, "Ada Lovelace", "Acme");
  const me = await c.get("/api/account/me");
  return { app, db: deps.db, c, orgId: me.body.organization.id as string };
}

describe("R77 brand colour maths", () => {
  it("every preset and any colour gives AA text on buttons and AA brand text on light and dark grounds", () => {
    const colours = [...PRESETS.map((p) => p.primary), "#ffff00", "#00ff00", "#ffffff", "#000000", "#7fdbff", "#ff4136"];
    for (const c of colours) {
      for (const scheme of ["light", "dark"] as const) {
        const t = colourTokens(c, null, scheme);
        expect(contrast(t["--color-brand"], t["--color-brand-fg"]), `${c} ${scheme} button`).toBeGreaterThanOrEqual(4.5);
        const ground = scheme === "light" ? "#ffffff" : "#161618";
        expect(contrast(t["--color-brand-hover"], ground), `${c} ${scheme} text`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("picks a readable text colour and flags pairs that fail before adjustment", () => {
    expect(readableOn("#ffff00")).toBe("#111113");
    expect(readableOn("#0b3d91")).toBe("#ffffff");
    expect(contrast(ensureContrast("#ffff00", "#ffffff"), "#ffffff")).toBeGreaterThanOrEqual(4.5);
    const fails = checkBrand({ primary: "#ffff00", accent: null, sidebar: null }).filter((c) => !c.ok).map((c) => c.id);
    expect(fails).toContain("link-light");
    expect(checkBrand({ primary: "#0e7490", accent: null, sidebar: null }).every((c) => c.ok || c.id === "link-dark")).toBe(true);
  });

  it("a default brand paints nothing; a brand paints only custom properties from validated values", () => {
    expect(brandCss(DEFAULT_BRAND)).toBe("");
    const b: Brand = { ...DEFAULT_BRAND, primary: "#be185d", sidebar: "#0f172a", radius: "round", density: "compact", font: "serif" };
    const css = brandCss(b);
    expect(css).toContain(":root{");
    expect(css).toContain("--color-brand:#be185d");
    expect(css).toContain('@media (prefers-color-scheme:dark)');
    expect(css).toContain("--spacing:0.21rem");
    expect(css).toContain(".glass-sidebar");
    expect(css).not.toMatch(/url\(|expression|<|@import/);
    expect(BrandPatchSchema.safeParse({ primary: "red;}body{x:y" }).success).toBe(false);
    expect(BrandPatchSchema.safeParse({ font: "Comic" }).success).toBe(false);
  });

  it("reads stored JSON leniently and a person's accent wins unless the brand is locked", () => {
    expect(readBrand("not json").primary).toBeNull();
    expect(readBrand(JSON.stringify({ primary: "#BE185D", junk: 1 })).primary).toBe(DEFAULT_BRAND.primary); // strict: unknown key drops all
    expect(readBrand(JSON.stringify({ primary: "#be185d" })).primary).toBe("#be185d");
    const b: Brand = { ...DEFAULT_BRAND, primary: "#15803d" };
    expect(brandCss(b, { followBrand: false, accent: "#be185d" })).toContain("#be185d");
    expect(brandCss({ ...b, locked: true }, { followBrand: false, accent: "#be185d" })).not.toContain("#be185d");
  });

  it("logo helpers: type sniffing, palette, best variant", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
    const px = new Uint8ClampedArray([200, 20, 60, 255, 200, 20, 60, 255, 255, 255, 255, 255, 10, 80, 200, 255]);
    const pal = paletteFromPixels(px);
    expect(pal[0]).toBe("#c8143c");
    expect(pal).toHaveLength(2);
    const b: Brand = { ...DEFAULT_BRAND, logos: { mark_light: "a1" } };
    expect(pickLogo(b, "mark", "dark")).toBe("mark_light");
    expect(pickLogo(b, "wide", "light")).toBeNull();
  });

  it("the boot script paints the cached brand and default appearance inside the app only", () => {
    const run = (path: string, store: Record<string, string>) => {
      const appended: { id?: string; textContent?: string }[] = [];
      const doc = { documentElement: { dataset: {} as Record<string, string> }, createElement: () => ({}) as { id?: string; textContent?: string }, head: { appendChild: (e: { id?: string; textContent?: string }) => appended.push(e) } };
      new Function("localStorage", "document", "location", THEME_SCRIPT)({ getItem: (k: string) => store[k] ?? null }, doc, { pathname: path });
      return { theme: doc.documentElement.dataset.theme, appended };
    };
    const cached = JSON.stringify({ o: "org_1", c: ":root{--color-brand:#be185d}", a: "dark" });
    const inApp = run("/app/my-work", { "multies-brand": cached });
    expect(inApp.theme).toBe("dark");
    expect(inApp.appended[0]).toMatchObject({ id: "brand-tokens", textContent: ":root{--color-brand:#be185d}" });
    expect(run("/app", { "multies-brand": cached, "multies-theme": "light" }).theme).toBe("light");
    const outside = run("/pricing", { "multies-brand": cached });
    expect(outside.theme).toBeUndefined();
    expect(outside.appended).toHaveLength(0);
    expect(() => run("/app", { "multies-brand": "{broken" })).not.toThrow();
  });
});

describe("R77 /api/branding", () => {
  it("members read; admins save, reset and upload logos; every change is audited", async () => {
    const { c, db, orgId } = await setup();
    const first = await c.get("/api/branding");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ orgId, canEdit: true, css: "" });
    const saved = await c.put("/api/branding", { primary: "#BE185D", radius: "round", appearance: "dark", locked: true, preset: "berry" });
    expect(saved.status).toBe(200);
    expect(saved.body.brand).toMatchObject({ primary: "#be185d", radius: "round", appearance: "dark", locked: true });
    expect((await c.get("/api/branding")).body.css).toContain("--color-brand:#be185d");
    expect((await c.put("/api/branding", { primary: "pink" })).status).toBe(422);
    expect((await c.put("/api/branding", { primary: "#000000", extra: 1 })).status).toBe(422);

    const noHeader = await (c as unknown as { app: { request: (p: string, i: RequestInit) => Promise<Response> } }).app.request("/api/branding/logo/mark_light", { method: "PUT", body: PNG, headers: { cookie: c.cookie, host: "localhost", "content-type": "image/png" } });
    expect(noHeader.status).toBe(403); // CSRF: a raw upload needs the upload header
    const res = await (c as unknown as { app: { request: (p: string, i: RequestInit) => Promise<Response> } }).app.request("/api/branding/logo/mark_light", { method: "PUT", body: PNG, headers: { cookie: c.cookie, host: "localhost", "content-type": "image/png", "x-multies-upload": "1" } });
    expect(res.status).toBe(200);
    const brand = ((await res.json()) as { brand: Brand }).brand;
    const v = brand.logos.mark_light!;
    expect(v).toMatch(/^[0-9a-f]{12}$/);
    const img = await (c as unknown as { app: { request: (p: string, i?: RequestInit) => Promise<Response> } }).app.request(`/api/branding/logo/${orgId}/mark_light/${v}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("cache-control")).toContain("immutable");
    expect(img.headers.get("x-content-type-options")).toBe("nosniff");
    const svg = await (c as unknown as { app: { request: (p: string, i: RequestInit) => Promise<Response> } }).app.request("/api/branding/logo/wide_dark", { method: "PUT", body: "<svg/>", headers: { cookie: c.cookie, host: "localhost", "content-type": "image/svg+xml", "x-multies-upload": "1" } });
    expect(svg.status).toBe(422);
    const big = await (c as unknown as { app: { request: (p: string, i: RequestInit) => Promise<Response> } }).app.request("/api/branding/logo/wide_dark", { method: "PUT", body: new Uint8Array(600 * 1024), headers: { cookie: c.cookie, host: "localhost", "content-type": "image/png", "x-multies-upload": "1" } });
    expect(big.status).toBe(413);
    expect((await c.get(`/api/branding/public/${orgId}`)).status).toBe(404); // no public look until a public page has a branding hook

    // Personal accent is ignored while the brand is locked.
    const mine = await c.put("/api/branding/me", { followBrand: false, accent: "#15803d" });
    expect(mine.status).toBe(200);
    expect(mine.body.css).not.toContain("#15803d");

    const reset = await c.del("/api/branding");
    expect(reset.status).toBe(200);
    expect(reset.body.brand).toMatchObject({ primary: null, logos: {} });
    const rows = await db.all<{ action: string }>(sql`select action from audit_logs where org_id = ${orgId} and (action like 'workspace.brand%' or action like 'workspace.logo%') order by created_at`);
    expect(rows.map((r) => r.action)).toEqual(["workspace.branding_changed", "workspace.logo_changed", "workspace.branding_reset"]);
  });

  it("a member cannot change the brand or logos but can set their own accent", async () => {
    const { c, db, orgId } = await setup();
    await db.run(sql`update members set role = 'member' where organization_id = ${orgId}`);
    expect((await c.get("/api/branding")).body.canEdit).toBe(false);
    expect((await c.put("/api/branding", { primary: "#be185d" })).status).toBe(403);
    expect((await c.del("/api/branding")).status).toBe(403);
    expect((await c.del("/api/branding/logo/mark_light")).status).toBe(403);
    const mine = await c.put("/api/branding/me", { followBrand: false, accent: "#15803d" });
    expect(mine.status).toBe(200);
    expect(mine.body.css).toContain("#15803d");
    expect((await c.get("/api/branding")).body.personal).toEqual({ followBrand: false, accent: "#15803d" });
  });

  it("needs a session for the workspace brand, and another workspace reads only its own", async () => {
    const { app, c } = await setup();
    await c.put("/api/branding", { primary: "#be185d" });
    expect((await new Client(app).get("/api/branding")).status).toBe(401);
    const other = new Client(app);
    await other.signup(undefined, "Grace Hopper", "Other Co");
    expect((await other.get("/api/branding")).body.brand.primary).toBeNull();
    expect((await other.put("/api/branding/logo/nope", {})).status).toBe(404);
  });
});

describe("R77 UX gate: sidebar contrast, phone spacing, logo variant", () => {
  it("keeps quiet sidebar text AA on the sidebar and on its fill, for every preset sidebar", () => {
    for (const s of [...PRESETS.map((p) => p.sidebar).filter((x): x is string => !!x), "#1e1b4b", "#1c1917", "#f5f5f4", "#fde68a"]) {
      const t = sidebarTokens(s);
      for (const k of ["--color-muted", "--color-subtle"]) {
        expect(contrast(t[k]!, s), `${k} on ${s}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t[k]!, t["--color-fill"]!), `${k} on fill of ${s}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it("applies compact spacing only from 640 px, so phones keep 44 px targets", () => {
    const css = brandCss({ ...DEFAULT_BRAND, density: "compact" } as Brand);
    expect(css).toContain("@media (min-width:640px){:root{--spacing:");
    expect(css.split("@media (min-width:640px)")[0]).not.toContain("--spacing");
  });
  it("picks the dark logo variant on a dark sidebar in light mode", () => {
    expect(logoScheme({ sidebar: "#1e1b4b" }, "light", true)).toBe("dark");
    expect(logoScheme({ sidebar: "#1e1b4b" }, "light", false)).toBe("light");
    expect(logoScheme({ sidebar: null }, "dark", true)).toBe("dark");
  });
});
