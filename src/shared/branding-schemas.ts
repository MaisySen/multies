/**
 * R77: the zod schemas for branding (API validation). Kept apart from ./branding so the app frame, which only
 * needs the token and logo helpers, does not load zod on its first screens.
 */
import { z } from "zod";
import { DEFAULT_BRAND, HEX, type Brand, type LogoKind } from "./branding";

const hex = z.string().trim().regex(HEX, "Pick a colour as #rrggbb.").transform((s) => s.toLowerCase());
export const BrandPatchSchema = z.object({
  primary: hex.nullable().optional(),
  accent: hex.nullable().optional(),
  sidebar: hex.nullable().optional(),
  radius: z.enum(["sharp", "default", "round"]).optional(),
  density: z.enum(["comfortable", "compact"]).optional(),
  font: z.enum(["system", "humanist", "geometric", "rounded", "serif", "mono"]).optional(),
  appearance: z.enum(["system", "light", "dark"]).optional(),
  locked: z.boolean().optional(),
  preset: z.string().trim().max(32).nullable().optional(),
}).strict();
export type BrandPatch = z.infer<typeof BrandPatchSchema>;

export const PersonalSchema = z.object({ followBrand: z.boolean(), accent: hex.nullable() }).strict();

/** A stored JSON brand, read leniently: anything unknown or invalid falls back to the default. */
export function readBrand(json: string | null | undefined, logos: Partial<Record<LogoKind, string>> = {}): Brand {
  let raw: unknown;
  try { raw = json ? JSON.parse(json) : null; } catch { raw = null; }
  const p = BrandPatchSchema.safeParse(raw && typeof raw === "object" ? raw : {});
  return { ...DEFAULT_BRAND, ...(p.success ? stripUndef(p.data) : {}), logos };
}
function stripUndef<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
