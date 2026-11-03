/**
 * R116: POST /api/translate { texts, target, source? } for the signed in person. app.ts registers it lazily (dynamic
 * import on first use) behind TRANSLATE_R116 and requireAuth, so the Worker starts exactly as before.
 */
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody } from "../middleware";
import { translateTexts } from "../services/translate-r116";

const schema = z.object({
  texts: z.array(z.string().max(4_000)).min(1).max(200),
  target: z.string().min(2).max(8),
  source: z.string().min(2).max(8).nullish(),
});

export async function translateHandler(c: Context<AppEnv>) {
  const input = await parseBody(c, schema);
  c.header("Cache-Control", "private, no-store");
  return c.json(await translateTexts(c.var.deps, { orgId: c.var.auth.orgId, userId: c.var.auth.userId }, input));
}
