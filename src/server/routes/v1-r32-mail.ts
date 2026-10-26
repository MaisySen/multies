/**
 * R32 in the public API (v1): POST /mail/messages/bulk, the same bulk actions the web app's selection bar uses
 * (services/mail/bulk-r32.ts). Up to 500 message ids; ids the key can't open are skipped. Read only keys get 403.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import { BULK_MAIL_ACTIONS, BULK_MAIL_MAX, runBulkMail } from "../services/mail/bulk-r32";
import type { ScheduleActor } from "../services/mail/schedules";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });

export const MailBulkBody = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(BULK_MAIL_MAX),
  action: z.enum(BULK_MAIL_ACTIONS),
  to: z.string().min(1).max(520).optional(),
  preset: z.enum(["later_today", "tomorrow", "next_week"]).optional(),
  at: z.string().max(40).optional(),
  local: z.string().max(20).optional(),
});

export function registerMailR32Routes(api: OpenAPIHono<AppEnv>) {
  api.openapi(createRoute({
    method: "post", path: "/mail/messages/bulk", tags: ["Messages"], summary: "Act on many messages at once",
    description: `Body: { ids (1 to ${BULK_MAIL_MAX} message ids), action, to?, preset?, at?, local? }. action: read, unread, star, unstar, archive, inbox, spam, trash, delete (forever), move (to: a connected mailbox's folder key, "f:<path>"), snooze (preset later_today, tomorrow or next_week, or at an ISO time, or local wall clock time) or unsnooze. Each inverse undoes its action: inbox undoes archive, unread undoes read, unsnooze undoes snooze. Ids the key can't open are skipped. Answers { updated } (and dueAt for snooze).`,
    security: [{ bearerAuth: [] }],
    request: { body: { required: true, content: { "application/json": { schema: MailBulkBody } } } },
    responses: { 200: json("OK."), 400: err("Bad request."), 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 422: err("Validation failed.") },
  }), async (c: Context<AppEnv>) => {
    const b = MailBulkBody.parse(await c.req.json().catch(() => ({})));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return c.json(await runBulkMail(c.var.deps, c.var.auth as unknown as ScheduleActor, b) as any, 200) as any;
  });
}
