/**
 * R31 in the public API (v1): Inbox splits (a person's own; personal keys only), the Inbox tabs with unread
 * counts, mail settings and read status of a sent message. GET /messages and the thread list take split.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import { mailboxScope } from "../services/team";
import { createSplit, deleteSplit, getSplit, listSplits, previewSplit, reorderSplits, splitTabs, updateSplit, type SplitActor } from "../services/mail/splits";
import { getMailPrefs, readStatusOf, setMailPrefs } from "../services/mail/read-status";
import { SplitCreate, SplitPatch, SplitPreview } from "@/shared/mail-splits";
import { MailPrefsPatch, SplitReorder } from "./mail-splits-r31";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (schema: any) => ({ body: { required: true, content: { "application/json": { schema } } } });
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
const MailboxQ = z.object({ mailboxId: z.string().max(64).optional().openapi({ param: { name: "mailboxId", in: "query" } }) });
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SplitActor & { role?: "owner" | "admin" | "member" };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown, status: 200 | 201 = 200) => c.json(data as any, status) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonBody = async (c: Context<AppEnv>, schema: { parse: (v: unknown) => any }) => schema.parse(await c.req.json().catch(() => ({})));
const pid = (c: Context<AppEnv>) => c.req.param("id") ?? "";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const scopeOf = async (c: Context<AppEnv>) => mailboxScope(c.var.deps.db, c.var.auth as any);

/** Read only keys may POST the preview: it counts and writes nothing. */
export const isSplitPreview = (method: string, path: string) => method === "POST" && /\/mail\/splits\/preview$/.test(path);

const RULES = "rules: [{ field, value }] with field one of fromContains, fromDomain, to (an address or a mailbox id), subjectContains, calendarInvite, fromTeammate (the last two take no value); match: all (default) or any; leavesImportant (default true) takes matching mail out of Important and Other.";

export function registerMailR31Routes(api: OpenAPIHono<AppEnv>) {
  const route = (method: "get" | "post" | "patch" | "delete", path: string, summary: string, description: string, extra: Record<string, unknown> = {}) =>
    createRoute({ method, path, tags: ["Mail splits"], summary, description, security: [{ bearerAuth: [] }], ...extra, responses: { 200: json("OK."), 201: json("Created."), 400: err("Bad request."), 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 404: err("Not found."), 409: err("Name already used."), 422: err("Validation failed.") } });

  api.openapi(route("get", "/mail/splits", "List Inbox splits and tabs", `The key owner's own Inbox splits in order, and the Inbox tabs (Important, Other, then each split) with unread counts. Personal keys only. Each split: { id, name, rules, match, leavesImportant, position }.`, { request: { query: MailboxQ } }),
    async (c) => send(c, { splits: await listSplits(c.var.deps, actor(c)), tabs: await splitTabs(c.var.deps, actor(c), { mailboxId: c.req.query("mailboxId") || undefined, scope: await scopeOf(c) }) }));
  api.openapi(route("post", "/mail/splits", "Create an Inbox split", `Body: { name (up to 40), rules (1 to 10), match?, leavesImportant?, position? }. ${RULES}`, { request: body(SplitCreate) }),
    async (c) => send(c, { split: await createSplit(c.var.deps, actor(c), await jsonBody(c, SplitCreate)) }, 201));
  api.openapi(route("post", "/mail/splits/preview", "Preview a split's rules", `Body: { rules, match?, mailboxId? }. Returns { threads }: how many Inbox threads the rules match. Writes nothing; read only keys can call it. ${RULES}`, { request: body(SplitPreview) }),
    async (c) => send(c, await previewSplit(c.var.deps, actor(c), await jsonBody(c, SplitPreview), await scopeOf(c))));
  api.openapi(route("post", "/mail/splits/reorder", "Reorder Inbox splits", "Body: { ids }: every split id once, in the new order.", { request: body(SplitReorder) }),
    async (c) => send(c, { splits: await reorderSplits(c.var.deps, actor(c), (await jsonBody(c, SplitReorder)).ids) }));
  api.openapi(route("get", "/mail/splits/{id}", "Get an Inbox split", "One of the key owner's splits.", { request: { params: Id } }),
    async (c) => send(c, { split: await getSplit(c.var.deps, actor(c), pid(c)) }));
  api.openapi(route("patch", "/mail/splits/{id}", "Edit an Inbox split", `Any of { name, rules, match, leavesImportant, position }. ${RULES}`, { request: { params: Id, ...body(SplitPatch) } }),
    async (c) => send(c, { split: await updateSplit(c.var.deps, actor(c), pid(c), await jsonBody(c, SplitPatch)) }));
  api.openapi(route("delete", "/mail/splits/{id}", "Delete an Inbox split", "Its mail goes back to Important or Other.", { request: { params: Id } }),
    async (c) => send(c, await deleteSplit(c.var.deps, actor(c), pid(c))));
  api.openapi(route("get", "/mail/prefs", "Get mail settings", "{ prefs: { readStatus } }. readStatus: whether mail the key owner sends carries an open image (off by default).", {}),
    async (c) => send(c, { prefs: await getMailPrefs(c.var.deps, actor(c)) }));
  api.openapi(route("patch", "/mail/prefs", "Change mail settings", "Body: { readStatus? }. Personal keys only.", { request: body(MailPrefsPatch) }),
    async (c) => send(c, { prefs: await setMailPrefs(c.var.deps, actor(c), await jsonBody(c, MailPrefsPatch)) }));
  api.openapi(route("get", "/mail/messages/{id}/read-status", "Read status of a sent message", "{ readStatus: { messageId, subject, folder, tracked, opens, firstOpenAt, lastOpenAt } }. tracked is false when the sender had read status off. Opens in the first 10 seconds and from scanners are not counted; several opens within a minute count once.", { request: { params: Id } }),
    async (c) => send(c, { readStatus: await readStatusOf(c.var.deps, actor(c), pid(c), await scopeOf(c)) }));
}
