/**
 * Guests: an outside person (a client) invited to one project by email. Guests are not
 * workspace members, so they take no paid seat on any plan. They see that project's tasks,
 * comments and docs, and can comment and upload files. Nothing else: no mail, no other
 * projects, no contacts, no time, no settings.
 *
 * The invite link carries a one time token. Opening it trades the token for a guest
 * session cookie; only SHA-256 hashes of both secrets are stored.
 */
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { isMimeType, isSafeToken, looksLikeEmail } from "../../lib/input-checks";
import type { AuthContext, Deps } from "../../context";
import { docs, organizations, projectGuests, sendApprovals, taskFiles, tasks } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { hmacSha256Hex, randomToken, safeEqual, sha256Hex } from "../../lib/crypto";
import { assertWritable, createdBy, iso, recordWrite, sortableId, type SuiteActor } from "./common";
import { addComment, getProject, listComments, listTasks, resolveTaskId, type Task } from "./tasks";
import { listFields } from "./fields";
import { deferrableWrite } from "../write-priority";
import { refuseAgentAddress } from "../agents/agent-address";
import { callerKind } from "../../lib/actor-kind";

const INVITE_DAYS = 14;
export const GUEST_COOKIE = "mm_guest";
export const GUEST_SESSION_DAYS = 90;
export const MAX_GUESTS_PER_PROJECT = 50;

type GuestRow = typeof projectGuests.$inferSelect;
type ApprovalStatus = (typeof sendApprovals.$inferSelect)["status"];
export function presentGuest(g: GuestRow, approvalStatus: ApprovalStatus | null = null) {
  return {
    id: g.id, projectId: g.projectId, email: g.email, name: g.name, status: g.status,
    invitedBy: { type: g.invitedByType, id: g.invitedById }, approvalId: g.approvalId,
    /** For an agent's invite: where its email stands in the approval queue. */
    approvalStatus: g.approvalId ? approvalStatus : null,
    lastSeenAt: iso(g.lastSeenAt), inviteExpiresAt: iso(g.inviteExpiresAt), createdAt: g.createdAt.toISOString(),
  };
}
export type Guest = ReturnType<typeof presentGuest>;

export async function listGuests(deps: Deps, orgId: string, projectId: string) {
  await getProject(deps, orgId, projectId); // 404 for another workspace's project
  const rows = await deps.db.select({ g: projectGuests, approval: sendApprovals.status }).from(projectGuests)
    .leftJoin(sendApprovals, eq(sendApprovals.id, projectGuests.approvalId))
    .where(and(eq(projectGuests.orgId, orgId), eq(projectGuests.projectId, projectId))).orderBy(desc(projectGuests.createdAt));
  return rows.filter((r) => r.g.status !== "revoked").map((r) => presentGuest(r.g, r.approval));
}

function inviteText(inviter: string, org: string, project: string) {
  return `${inviter} at ${org} invited you to the project "${project}" on Multies.\n\nYou can see its tasks, comments and docs, add comments and upload files. You don't need an account and it's free.\n\nThe link works for ${INVITE_DAYS} days on any of your devices and only for you, so please don't forward it.`;
}

/**
 * Invites a guest. A person (or a workspace key) sends the invite at once through Multies'
 * own account mail. An agent's invite is mail that leaves the business, so it goes through
 * that agent's approval rules and waits in the approval queue when they require it.
 */
export async function inviteGuest(deps: Deps, actor: SuiteActor, projectId: string, input: { email: string; name?: string }) {
  assertWritable(actor);
  const project = await getProject(deps, actor.orgId, projectId);
  const email = input.email.trim().toLowerCase();
  if (!looksLikeEmail(email)) throw new HttpError(422, "validation_failed", "That email address doesn't look right.");
  // AIS1 (row 1): an AI agent's inbox is never a guest: the invite link would land in the agent's feed.
  await refuseAgentAddress(deps, email, { action: "guest.invite_refused", orgId: actor.orgId, actorUserId: actor.userId || null, actorEmail: actor.email, metadata: { projectId: project.id, via: callerKind(actor), ...(actor.agentId ? { agentId: actor.agentId } : {}) } });
  const existing = await deps.db.select().from(projectGuests).where(and(eq(projectGuests.projectId, project.id), eq(projectGuests.email, email))).get();
  if (!existing) {
    const count = (await listGuests(deps, actor.orgId, project.id)).length;
    if (count >= MAX_GUESTS_PER_PROJECT) throw new HttpError(422, "too_many_guests", `A project can have up to ${MAX_GUESTS_PER_PROJECT} guests.`);
  }
  const token = randomToken(32);
  const now = deps.now();
  const by = createdBy(actor);
  const values = {
    name: (input.name ?? existing?.name ?? "").trim().slice(0, 80), status: existing?.status === "active" ? "active" as const : "pending" as const,
    inviteHash: await sha256Hex(token), inviteExpiresAt: new Date(now.getTime() + INVITE_DAYS * 86_400_000),
    invitedByType: (by.createdByType === "agent" ? "agent" : "member") as "agent" | "member", invitedById: by.createdById, updatedAt: now,
  };
  const id = existing?.id ?? sortableId("gst", now.getTime());
  if (existing) await deps.db.update(projectGuests).set(values).where(eq(projectGuests.id, existing.id));
  else await deps.db.insert(projectGuests).values({ id, orgId: actor.orgId, projectId: project.id, email, ...values, createdAt: now });

  const org = await deps.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, actor.orgId)).get();
  const url = `${deps.config.appUrl}/g/${token}`;
  const subject = `You're invited to ${project.name}`;
  let delivery: { status: "sent" | "pending_approval" | "not_sent"; approvalId?: string; detail?: string };
  if (actor.agentId) {
    const { requestSend } = await import("../agents");
    const res = await requestSend(deps, actor as unknown as AuthContext & { agentId: string }, actor.agentId, {
      to: [email], subject, text: `${inviteText(actor.name, org?.name ?? "Multies", project.name)}\n\nOpen the project: ${url}\n`,
    });
    if (res.status === "pending_approval") {
      await deps.db.update(projectGuests).set({ approvalId: res.approval.id }).where(eq(projectGuests.id, id));
      delivery = { status: "pending_approval", approvalId: res.approval.id };
    } else delivery = { status: "sent" };
  } else {
    const { sendSystemEmail } = await import("../system-mail");
    const res = await sendSystemEmail(deps, {
      to: email, subject, text: inviteText(actor.name || actor.email, org?.name ?? "Multies", project.name),
      action: { label: "Open the project", url }, template: "guest-invite", orgId: actor.orgId,
    });
    delivery = res.delivered ? { status: "sent" } : { status: "not_sent", detail: res.detail };
  }
  const guest = presentGuest((await deps.db.select().from(projectGuests).where(eq(projectGuests.id, id)).get())!, delivery.status === "pending_approval" ? "pending" : null);
  await recordWrite(deps, actor, { entityType: "project", entityId: project.id, op: "update", verb: "invited_guest", data: { guestId: id, email }, event: "guest.invited", eventData: { guest, delivery: delivery.status } });
  // The link is only handed back when the email did not go out, so a person can pass it on by hand.
  return { guest, delivery, ...(delivery.status === "not_sent" && !actor.agentId ? { inviteUrl: url } : {}) };
}

/**
 * R58 (MB-253): a fresh invite link for a guest who has not joined, without sending any email, so a person whose invite
 * did not reach the guest can pass the link on by hand. The old link stops working. Only a person gets it (an agent's
 * invite goes through its approval queue, so an agent never gets a link and an agent's invite is never re-linked here).
 * One row update: essential (a person's own action), never deferred.
 */
export async function newGuestLink(deps: Deps, actor: SuiteActor, guestId: string) {
  assertWritable(actor);
  if (actor.agentId) throw new HttpError(403, "forbidden", "Only a person can get an invite link to share.");
  const g = await deps.db.select().from(projectGuests).where(and(eq(projectGuests.orgId, actor.orgId), eq(projectGuests.id, guestId))).get();
  if (!g || g.status === "revoked") throw notFound("Guest");
  if (g.status === "active") throw new HttpError(409, "already_joined", "This guest has already joined, so they don't need a link.");
  if (g.approvalId) throw new HttpError(409, "waiting_for_approval", "This invite is waiting for approval, so it can't be shared by hand yet.");
  await refuseAgentAddress(deps, g.email, { action: "guest.invite_refused", orgId: actor.orgId, actorUserId: actor.userId || null, actorEmail: actor.email, metadata: { guestId: g.id } });
  await getProject(deps, actor.orgId, g.projectId); // the project must still be there
  const token = randomToken(32);
  const now = deps.now();
  await deps.db.update(projectGuests).set({ inviteHash: await sha256Hex(token), inviteExpiresAt: new Date(now.getTime() + INVITE_DAYS * 86_400_000), updatedAt: now }).where(eq(projectGuests.id, g.id));
  return { inviteUrl: `${deps.config.appUrl}/g/${token}`, inviteExpiresAt: new Date(now.getTime() + INVITE_DAYS * 86_400_000).toISOString() };
}

export async function revokeGuest(deps: Deps, actor: SuiteActor, guestId: string) {
  assertWritable(actor);
  const g = await deps.db.select().from(projectGuests).where(and(eq(projectGuests.orgId, actor.orgId), eq(projectGuests.id, guestId))).get();
  if (!g || g.status === "revoked") throw notFound("Guest");
  await deps.db.update(projectGuests).set({ status: "revoked", sessionHash: null, inviteHash: null, updatedAt: deps.now() }).where(eq(projectGuests.id, g.id));
  await recordWrite(deps, actor, { entityType: "project", entityId: g.projectId, op: "update", verb: "removed_guest", data: { guestId: g.id, email: g.email }, event: "guest.revoked", eventData: { guest: presentGuest({ ...g, status: "revoked" }) } });
  return { ok: true as const };
}

// ---------------------------------------------------------------- the guest's side

/** Trades an invite token for a session. Returns the cookie value. */
export async function acceptInvite(deps: Deps, token: string) {
  if (!isSafeToken(token, 20, 100)) throw new HttpError(404, "invite_not_found", "This invite link is not valid. Ask for a new one.");
  const g = await deps.db.select().from(projectGuests).where(eq(projectGuests.inviteHash, await sha256Hex(token))).get();
  const now = deps.now();
  if (!g || g.status === "revoked") throw new HttpError(404, "invite_not_found", "This invite link is not valid. Ask for a new one.");
  if (!g.inviteExpiresAt || g.inviteExpiresAt < now) throw new HttpError(410, "invite_expired", "This invite link has expired. Ask for a new one.");
  // AIS1 (row 1): an invite made before the fix to an address that reaches an AI agent never opens.
  await refuseAgentAddress(deps, g.email, { action: "guest.join_refused", orgId: g.orgId, metadata: { guestId: g.id } });
  if (g.approvalId) {
    // An agent's invite counts only once a person approved its email.
    const a = await deps.db.select({ status: sendApprovals.status }).from(sendApprovals).where(eq(sendApprovals.id, g.approvalId)).get();
    if (a?.status !== "sent") throw new HttpError(404, "invite_not_found", "This invite link is not valid. Ask for a new one.");
  }
  /* R41 (MB-227): the link opens on every device of the guest until it expires (a phone and a laptop), instead of only
   * the first. The first device gets the stored session; each later device gets its own session, signed with the app
   * secret and bound to that stored session, so opening the link again never signs out a device that already has it,
   * and removing the guest (which clears the stored session) ends every device at once. */
  if (g.status === "active" && g.sessionHash) {
    const nonce = randomToken(18).replace(/[^A-Za-z0-9]/g, "");
    await deferrableWrite(deps, "last_seen", `guest:${g.id}`, () => deps.db.update(projectGuests).set({ lastSeenAt: now }).where(eq(projectGuests.id, g.id)));
    return { cookie: `${g.id}.${nonce}.${await deviceSig(deps, g.id, nonce, g.sessionHash)}`, guestId: g.id };
  }
  const secret = randomToken(32);
  // Essential write: the guest becomes active with its first session. The invite stays usable until it expires.
  await deps.db.update(projectGuests).set({ status: "active", sessionHash: await sha256Hex(secret), lastSeenAt: now, updatedAt: now }).where(eq(projectGuests.id, g.id));
  if (g.status === "pending") {
    const actor: SuiteActor = { orgId: g.orgId, userId: "", email: g.email, name: g.name || g.email, system: true };
    await recordWrite(deps, actor, { entityType: "project", entityId: g.projectId, op: "update", verb: "guest_joined", data: { guestId: g.id, email: g.email }, event: "guest.joined", eventData: { guest: presentGuest({ ...g, status: "active" }) } });
  }
  return { cookie: `${g.id}.${secret}`, guestId: g.id };
}

export interface GuestContext { guest: GuestRow; actor: SuiteActor }

/** The guest behind a session cookie, or null. */
export async function resolveGuest(deps: Deps, cookie: string | undefined): Promise<GuestContext | null> {
  if (!cookie) return null;
  const [id, secret, sig] = cookie.split(".");
  if (!id || !secret || !isSafeToken(id)) return null;
  const g = await deps.db.select().from(projectGuests).where(eq(projectGuests.id, id)).get();
  if (!g || g.status !== "active" || !g.sessionHash) return null;
  // R41: a later device's session (id.nonce.signature) or the first device's stored one (id.secret).
  if (sig ? !safeEqual(sig, await deviceSig(deps, g.id, secret, g.sessionHash)) : g.sessionHash !== await sha256Hex(secret)) return null;
  const now = deps.now();
  if (!g.lastSeenAt || now.getTime() - g.lastSeenAt.getTime() > 3_600_000) await deferrableWrite(deps, "last_seen", `guest:${g.id}`, () => deps.db.update(projectGuests).set({ lastSeenAt: now }).where(eq(projectGuests.id, g.id))); // R32: deferrable
  return { guest: g, actor: { orgId: g.orgId, userId: "", email: g.email, name: `${g.name || g.email} (guest)`, role: "member" } };
}

/** A task as a guest sees it: no email source, no assignee email. */
function forGuest(t: Task) {
  return { ...t, source: null, assignee: t.assignee ? { ...t.assignee, email: null } : null };
}

async function guestTask(deps: Deps, g: GuestContext, idOrRef: string) {
  const id = await resolveTaskId(deps, g.guest.orgId, idOrRef);
  const t = await deps.db.select({ id: tasks.id, projectId: tasks.projectId }).from(tasks).where(and(eq(tasks.orgId, g.guest.orgId), eq(tasks.id, id), isNull(tasks.deletedAt))).get();
  if (!t || t.projectId !== g.guest.projectId) throw notFound("Task");
  return t;
}

export async function guestHome(deps: Deps, g: GuestContext) {
  const [project, org, list, fields, docRows] = await Promise.all([
    getProject(deps, g.guest.orgId, g.guest.projectId),
    deps.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, g.guest.orgId)).get(),
    listTasks(deps, g.actor, { projectId: g.guest.projectId, includeSubtasks: true }),
    listFields(deps, g.guest.orgId, g.guest.projectId),
    deps.db.select({ id: docs.id, title: docs.title, updatedAt: docs.updatedAt }).from(docs)
      .where(and(eq(docs.orgId, g.guest.orgId), eq(docs.projectId, g.guest.projectId), isNull(docs.deletedAt))).orderBy(desc(docs.updatedAt)).limit(200),
  ]);
  return {
    guest: { id: g.guest.id, email: g.guest.email, name: g.guest.name },
    workspace: { name: org?.name ?? "" },
    project: { id: project.id, name: project.name, key: project.key, color: project.color, statuses: project.statuses },
    tasks: list.map(forGuest), customFields: fields,
    docs: docRows.map((d) => ({ id: d.id, title: d.title, updatedAt: d.updatedAt.toISOString() })),
  };
}

export async function guestTaskDetail(deps: Deps, g: GuestContext, idOrRef: string) {
  const t = await guestTask(deps, g, idOrRef);
  const [list, comments, files, fields] = await Promise.all([
    listTasks(deps, g.actor, { projectId: g.guest.projectId, includeSubtasks: true }),
    listComments(deps, g.guest.orgId, t.id),
    listFiles(deps, g.guest.orgId, t.id),
    listFields(deps, g.guest.orgId, g.guest.projectId),
  ]);
  const task = list.find((x) => x.id === t.id);
  if (!task) throw notFound("Task");
  return { task: forGuest(task), subtasks: list.filter((x) => x.parentId === t.id).map(forGuest), comments, files, customFields: fields };
}

export async function guestComment(deps: Deps, g: GuestContext, idOrRef: string, body: string) {
  const t = await guestTask(deps, g, idOrRef);
  return addComment(deps, g.actor, t.id, body);
}

export async function guestDoc(deps: Deps, g: GuestContext, id: string) {
  const d = await deps.db.select().from(docs).where(and(eq(docs.orgId, g.guest.orgId), eq(docs.id, id), isNull(docs.deletedAt))).get();
  if (!d || d.projectId !== g.guest.projectId) throw notFound("Doc");
  return { id: d.id, title: d.title, content: JSON.parse(d.content) as unknown, updatedAt: d.updatedAt.toISOString() };
}

// ---------------------------------------------------------------- files on tasks

/** Files up to 1 MB stay in the database; with a body store configured, up to 10 MB. */
export const INLINE_FILE_LIMIT = 1_000_000;
export const STORED_FILE_LIMIT = 10_000_000;

export async function listFiles(deps: Deps, orgId: string, taskId: string) {
  const rows = await deps.db.select({ id: taskFiles.id, filename: taskFiles.filename, contentType: taskFiles.contentType, sizeBytes: taskFiles.sizeBytes, uploadedByType: taskFiles.uploadedByType, uploadedByName: taskFiles.uploadedByName, createdAt: taskFiles.createdAt })
    .from(taskFiles).where(and(eq(taskFiles.orgId, orgId), eq(taskFiles.taskId, taskId))).orderBy(asc(taskFiles.createdAt));
  return rows.map((r) => ({ id: r.id, filename: r.filename, contentType: r.contentType, sizeBytes: r.sizeBytes, uploadedBy: { type: r.uploadedByType, name: r.uploadedByName }, createdAt: r.createdAt.toISOString() }));
}

const cleanName = (n: string) => n.replace(/[\\/\r\n"<>]/g, "_").replace(/^\.+/, "").slice(0, 160) || "file";

export async function addFile(deps: Deps, actor: SuiteActor, taskIdOrRef: string, file: { name: string; type: string; bytes: Uint8Array }, by: { type: "member" | "agent" | "guest"; id: string | null; name: string }, guestProjectId?: string) {
  assertWritable(actor);
  const id = await resolveTaskId(deps, actor.orgId, taskIdOrRef);
  const t = await deps.db.select({ id: tasks.id, projectId: tasks.projectId, version: tasks.version }).from(tasks).where(and(eq(tasks.orgId, actor.orgId), eq(tasks.id, id), isNull(tasks.deletedAt))).get();
  if (!t || (guestProjectId && t.projectId !== guestProjectId)) throw notFound("Task");
  if (!file.bytes.length) throw new HttpError(422, "validation_failed", "That file is empty.");
  const store = deps.bodyStore;
  const limit = store ? STORED_FILE_LIMIT : INLINE_FILE_LIMIT;
  if (file.bytes.length > limit) throw new HttpError(413, "file_too_large", `Files can be up to ${Math.round(limit / 1_000_000)} MB here.`);
  const now = deps.now();
  const fileId = sortableId("fil", now.getTime());
  const contentType = isMimeType(file.type) ? file.type.slice(0, 100) : "application/octet-stream";
  let contentB64: string | null = null, storageKey: string | null = null;
  if (file.bytes.length > INLINE_FILE_LIMIT && store) {
    storageKey = `task-files/${actor.orgId}/${fileId}`;
    await store.put(storageKey, file.bytes, contentType);
  } else {
    const { toB64 } = await import("../../lib/crypto");
    contentB64 = toB64(file.bytes);
  }
  await deps.db.insert(taskFiles).values({ id: fileId, orgId: actor.orgId, taskId: t.id, filename: cleanName(file.name), contentType, sizeBytes: file.bytes.length, contentB64, storageKey, uploadedByType: by.type, uploadedById: by.id, uploadedByName: by.name.slice(0, 120), createdAt: now });
  const out = { id: fileId, filename: cleanName(file.name), contentType, sizeBytes: file.bytes.length, uploadedBy: { type: by.type, name: by.name }, createdAt: now.toISOString() };
  await deps.db.update(tasks).set({ updatedAt: now }).where(eq(tasks.id, t.id));
  await recordWrite(deps, actor, { entityType: "task", entityId: t.id, op: "update", version: t.version, verb: "added_file", data: { fileId, filename: out.filename }, event: "task.file_added", eventData: { taskId: t.id, file: out } });
  return out;
}

export async function readFile(deps: Deps, orgId: string, fileId: string, guestProjectId?: string) {
  const f = await deps.db.select().from(taskFiles).where(and(eq(taskFiles.orgId, orgId), eq(taskFiles.id, fileId))).get();
  if (!f) throw notFound("File");
  if (guestProjectId) {
    const t = await deps.db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, f.taskId)).get();
    if (!t || t.projectId !== guestProjectId) throw notFound("File");
  }
  let bytes: Uint8Array | null = null;
  if (f.contentB64) { const { fromB64 } = await import("../../lib/crypto"); bytes = fromB64(f.contentB64); }
  else if (f.storageKey && deps.bodyStore) bytes = await deps.bodyStore.get(f.storageKey);
  if (!bytes) throw notFound("File");
  return { filename: f.filename, contentType: f.contentType, bytes };
}

/** The project's guests for the projects list (the count only), used by the seats note. */
export async function guestCounts(deps: Deps, orgId: string) {
  const rows = await deps.db.select({ projectId: projectGuests.projectId, status: projectGuests.status }).from(projectGuests).where(eq(projectGuests.orgId, orgId));
  const m = new Map<string, number>();
  for (const r of rows) if (r.status !== "revoked") m.set(r.projectId, (m.get(r.projectId) ?? 0) + 1);
  return m;
}

/** R41 (MB-227): the signature of a later device's guest session, bound to the guest's stored session. */
async function deviceSig(deps: Deps, guestId: string, nonce: string, sessionHash: string) {
  return hmacSha256Hex(deps.config.appSecret, `guest-device:${guestId}:${nonce}:${sessionHash}`);
}
