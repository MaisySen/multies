/**
 * Round 8 of the suite in the app (cookie session): custom fields, the portfolio, guests and
 * files on tasks, plus the guest's own endpoints (a separate guest session cookie, never a
 * workspace session). The same services back the REST API (v1-suite-r8.ts) and MCP.
 */
import { addGuestComment, listForGuest } from "../services/docs-plus/comments"; // R103
import { assertTablesOn, listRows, tableDetail } from "../services/tables-r125"; // R125
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, parseQuery, requireAdmin, requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { fromB64 } from "../lib/crypto";
import { createField, createWorkspaceField, deleteField, deleteWorkspaceField, listFields, listWorkspaceFields, updateField, updateWorkspaceField } from "../services/suite/fields";
import { portfolio } from "../services/suite/portfolio";
import {
  acceptInvite, addFile, GUEST_COOKIE, GUEST_SESSION_DAYS, guestComment, guestDoc, guestHome, guestTaskDetail, inviteGuest, listFiles, listGuests, newGuestLink, readFile, resolveGuest, revokeGuest,
  type GuestContext,
} from "../services/suite/guests";
import { assertCoursesOn, courseDetail, lessonPage } from "../services/courses-r129"; // R129
import { resolveTaskId } from "../services/suite/tasks";
import { CommentCreate, FieldCreate, FieldPatch, GuestInvite, WorkspaceFieldCreate, WorkspaceFieldPatch } from "./suite-schemas";

// R52: query schemas built once per isolate, not on every request (zod schema construction is real CPU on a warm request).
const Q_SUITE_R8_1 = z.object({ projectId: z.string().min(1) });
const Q_SUITE_R8_2 = z.object({ projectId: z.string().min(1) });
const Q_SUITE_R8_3 = z.object({ taskId: z.string().min(1) });

export const FileUpload = z.object({
  filename: z.string().trim().min(1).max(200), contentType: z.string().max(100).optional(),
  contentBase64: z.string().min(1).max(14_000_000),
});

/** Sends a stored file as a download, never rendered inline, so an uploaded page can't run here. */
function download(f: { filename: string; contentType: string; bytes: Uint8Array }) {
  return new Response(f.bytes as BodyInit, {
    headers: {
      "content-type": f.contentType, "content-length": String(f.bytes.length),
      "content-disposition": `attachment; filename="${f.filename.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
      "x-content-type-options": "nosniff", "cache-control": "private, no-store", "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

function decodeUpload(b: z.infer<typeof FileUpload>) {
  try { return { name: b.filename, type: b.contentType ?? "application/octet-stream", bytes: fromB64(b.contentBase64) }; }
  catch { throw new HttpError(422, "validation_failed", "The file content must be base64."); }
}

export function fieldRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    // R84: fields defined once for the whole workspace (a copy in every project).
    .get("/workspace", async (c) => c.json({ fields: await listWorkspaceFields(c.var.deps, c.var.auth.orgId) }))
    // R84F: a workspace field lands on every project, so admins add, change and delete them; members use them.
    .post("/workspace", requireAdmin, async (c) => c.json({ field: await createWorkspaceField(c.var.deps, c.var.auth, await parseBody(c, WorkspaceFieldCreate)) }, 201))
    .patch("/workspace/:key", requireAdmin, async (c) => c.json({ field: await updateWorkspaceField(c.var.deps, c.var.auth, c.req.param("key"), await parseBody(c, WorkspaceFieldPatch)) }))
    .delete("/workspace/:key", requireAdmin, async (c) => c.json(await deleteWorkspaceField(c.var.deps, c.var.auth, c.req.param("key"))))
    .get("/", async (c) => {
      const { projectId } = parseQuery(c, Q_SUITE_R8_1);
      return c.json({ fields: await listFields(c.var.deps, c.var.auth.orgId, projectId) });
    })
    .post("/", async (c) => {
      const b = await parseBody(c, FieldCreate.extend({ projectId: z.string().min(1) }));
      return c.json({ field: await createField(c.var.deps, c.var.auth, b.projectId, b) }, 201);
    })
    .patch("/:id", async (c) => c.json({ field: await updateField(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, FieldPatch)) }))
    .delete("/:id", async (c) => c.json(await deleteField(c.var.deps, c.var.auth, c.req.param("id"))));
}

export function portfolioRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json({ projects: await portfolio(c.var.deps, c.var.auth.orgId, { includeArchived: c.req.query("archived") === "1" }) }));
}

export function guestAdminRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => {
      const { projectId } = parseQuery(c, Q_SUITE_R8_2);
      return c.json({ guests: await listGuests(c.var.deps, c.var.auth.orgId, projectId) });
    })
    .post("/", async (c) => {
      const b = await parseBody(c, GuestInvite.extend({ projectId: z.string().min(1) }));
      return c.json(await inviteGuest(c.var.deps, c.var.auth, b.projectId, b), 201);
    })
    // R58 (MB-253): a new link to share by hand when the invite email did not reach the guest. No email is sent.
    .post("/:id/link", async (c) => c.json(await newGuestLink(c.var.deps, c.var.auth, c.req.param("id"))))
    .delete("/:id", async (c) => c.json(await revokeGuest(c.var.deps, c.var.auth, c.req.param("id"))));
}

export function fileRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => {
      const { taskId } = parseQuery(c, Q_SUITE_R8_3);
      return c.json({ files: await listFiles(c.var.deps, c.var.auth.orgId, await resolveTaskId(c.var.deps, c.var.auth.orgId, taskId)) });
    })
    .post("/", async (c) => {
      const b = await parseBody(c, FileUpload.extend({ taskId: z.string().min(1).optional() }));
      const taskId = b.taskId ?? c.req.query("taskId");
      if (!taskId) throw new HttpError(422, "validation_failed", "Pass taskId.");
      const a = c.var.auth;
      return c.json({ file: await addFile(c.var.deps, a, taskId, decodeUpload(b), { type: "member", id: a.userId, name: a.name || a.email }) }, 201);
    })
    .get("/:id/download", async (c) => download(await readFile(c.var.deps, c.var.auth.orgId, c.req.param("id"))));
}

// ---------------------------------------------------------------- the guest's side

type GuestEnv = AppEnv & { Variables: AppEnv["Variables"] & { guest: GuestContext } };
const secure = (c: Context) => new URL(c.req.url).protocol === "https:";

const requireGuest: MiddlewareHandler<GuestEnv> = async (c, next) => {
  const g = await resolveGuest(c.var.deps, getCookie(c, GUEST_COOKIE));
  if (!g) throw new HttpError(401, "guest_unauthenticated", "Open your invite link again, or ask for a new one.");
  c.set("guest", g);
  await next();
};

export function guestRoutes() {
  const signedIn = new Hono<GuestEnv>()
    .use("*", requireGuest)
    .get("/me", async (c) => c.json(await guestHome(c.var.deps, c.var.guest)))
    .get("/tasks/:id", async (c) => c.json(await guestTaskDetail(c.var.deps, c.var.guest, c.req.param("id"))))
    .post("/tasks/:id/comments", async (c) => c.json({ comment: await guestComment(c.var.deps, c.var.guest, c.req.param("id"), (await parseBody(c, CommentCreate)).body) }, 201))
    .post("/tasks/:id/files", async (c) => {
      const g = c.var.guest;
      const b = await parseBody(c, FileUpload);
      return c.json({ file: await addFile(c.var.deps, g.actor, c.req.param("id"), decodeUpload(b), { type: "guest", id: g.guest.id, name: g.actor.name }, g.guest.projectId) }, 201);
    })
    .get("/files/:id", async (c) => download(await readFile(c.var.deps, c.var.guest.guest.orgId, c.req.param("id"), c.var.guest.guest.projectId)))
    .get("/docs/:id", async (c) => c.json({ doc: await guestDoc(c.var.deps, c.var.guest, c.req.param("id")) }))
    // R125: a guest reads tables in their project (read only; linked rows outside it stay hidden).
    .get("/tables/:id", async (c) => { await assertTablesOn(c.var.deps, c.var.guest.guest.orgId); return c.json(await tableDetail(c.var.deps, { kind: "guest", actor: c.var.guest.actor, projectId: c.var.guest.guest.projectId }, c.req.param("id"))); })
    .get("/tables/:id/rows", async (c) => { await assertTablesOn(c.var.deps, c.var.guest.guest.orgId); return c.json(await listRows(c.var.deps, { kind: "guest", actor: c.var.guest.actor, projectId: c.var.guest.guest.projectId }, c.req.param("id"), { cursor: c.req.query("cursor") || undefined, q: (c.req.query("q") ?? "").slice(0, 200) || undefined, viewId: c.req.query("view") || undefined })); })
    // R129: a guest reads a published course in their project (lessons only: no progress, quiz or table).
    .get("/courses/:id", async (c) => { await assertCoursesOn(c.var.deps, c.var.guest.guest.orgId); return c.json(await courseDetail(c.var.deps, { kind: "guest", actor: c.var.guest.actor, projectId: c.var.guest.guest.projectId }, c.req.param("id"))); })
    .get("/courses/:id/lessons/:lid/page", async (c) => { await assertCoursesOn(c.var.deps, c.var.guest.guest.orgId); return c.json(await lessonPage(c.var.deps, { kind: "guest", actor: c.var.guest.actor, projectId: c.var.guest.guest.projectId }, c.req.param("id"), c.req.param("lid"))); })
    // R103: comments on the project's docs (DOCS_PLUS_R103=on).
    .get("/r103/docs/:id/comments", async (c) => {
      if (!c.var.deps.config.docsPlus) return c.json({ error: { code: "not_found", message: "Not found" } }, 404);
      return c.json(await listForGuest(c.var.deps, c.var.guest, c.req.param("id")));
    })
    .post("/r103/docs/:id/comments", async (c) => {
      if (!c.var.deps.config.docsPlus) return c.json({ error: { code: "not_found", message: "Not found" } }, 404);
      return c.json({ comment: await addGuestComment(c.var.deps, c.var.guest, c.req.param("id"), (await parseBody(c, CommentCreate)).body) }, 201);
    });

  return new Hono<GuestEnv>()
    .post("/accept", async (c) => {
      const { token } = await parseBody(c, z.object({ token: z.string().min(1).max(200) }));
      const s = await acceptInvite(c.var.deps, token);
      setCookie(c, GUEST_COOKIE, s.cookie, { httpOnly: true, secure: secure(c), sameSite: "Lax", path: "/api/guest", maxAge: GUEST_SESSION_DAYS * 86_400 });
      return c.json({ ok: true });
    })
    .post("/signout", async (c) => {
      deleteCookie(c, GUEST_COOKIE, { path: "/api/guest", secure: secure(c) });
      return c.json({ ok: true });
    })
    .route("/", signedIn);
}
