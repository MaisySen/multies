/**
 * R104 (LANG_R104): workspace admins suggest a better wording for a translated string. Suggestions are kept in the
 * workspace's own audit log (action "translation.suggested"), so nothing new is stored and nothing applies itself: they
 * wait there for a person to review. app.ts registers this lazily (dynamic import on first use) behind LANG_R104
 * and requireAuth (the handler lets owners and admins only), so the Worker starts exactly as before.
 */
import type { Context } from "hono";
import { and, desc, eq, gte } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../context";
import { auditLogs } from "../db/schema";
import { forbidden } from "../lib/errors";
import { parseBody } from "../middleware";
import { audit } from "../services/audit";

export const SUGGESTION_ACTION = "translation.suggested";
const DAY = 86_400_000;

const schema = z.object({
  key: z.string().trim().min(3).max(120).regex(/^[a-z0-9_.-]+$/, "Pick a string from the list."),
  lang: z.enum(["ne", "hi"]),
  suggestion: z.string().trim().min(1, "Write the wording you would use.").max(500, "Keep it under 500 characters."),
  current: z.string().max(500).optional(),
  english: z.string().max(500).optional(),
});

export interface Suggestion { id: string; key: string; lang: string; suggestion: string; current: string | null; english: string | null; by: string | null; at: string }

const meta = (raw: string | null): Record<string, unknown> => {
  try { return raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { return {}; }
};

export async function suggestionsHandler(c: Context<AppEnv>) {
  const { auth, deps } = c.var;
  if (auth.role !== "owner" && auth.role !== "admin") throw forbidden("Only workspace admins can do that.");
  c.header("Cache-Control", "private, no-store");
  if (c.req.method === "POST") {
    const input = await parseBody(c, schema);
    await audit(deps.db, {
      orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: SUGGESTION_ACTION, targetType: "translation", targetId: input.key,
      metadata: { lang: input.lang, suggestion: input.suggestion, current: input.current ?? null, english: input.english ?? null }, ip: c.var.ip,
    });
    return c.json({ ok: true }, 201);
  }
  // The last 90 days, newest first, at most 50 (the audit index is org then time; the action filter rides on it).
  const since = new Date(Date.now() - 90 * DAY);
  const rows = await deps.db.select({ id: auditLogs.id, key: auditLogs.targetId, metadata: auditLogs.metadata, by: auditLogs.actorEmail, at: auditLogs.createdAt })
    .from(auditLogs).where(and(eq(auditLogs.orgId, auth.orgId), gte(auditLogs.createdAt, since), eq(auditLogs.action, SUGGESTION_ACTION)))
    .orderBy(desc(auditLogs.createdAt)).limit(50);
  const suggestions: Suggestion[] = rows.map((r) => {
    const m = meta(r.metadata);
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    return { id: r.id, key: r.key ?? "", lang: str(m.lang) ?? "", suggestion: str(m.suggestion) ?? "", current: str(m.current), english: str(m.english), by: r.by, at: new Date(r.at).toISOString() };
  });
  return c.json({ suggestions });
}
