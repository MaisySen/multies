/**
 * R43 the scheduled pass that finishes kept imports (see kept-file.ts). Every cron tick (15 minutes on prod and
 * staging) it takes at most CONTINUE_LIMIT runs whose file is kept and whose page has been quiet for KEPT_IDLE_MIN
 * minutes, claims each (last_step_at moves only if no step ran since the read, so it never races the page), and runs
 * up to CONTINUE_STEPS steps as the person who started it, exactly as the page would. A mail archive runs up to
 * MBOX_CONTINUE_BATCHES batches of 3 messages. CPU per step is the same as one page step (free plan). When the run is
 * done the usual "finished" email goes out (once); a file past its KEEP_DAYS is dropped, and the run then gets the
 * "paused" email from the left behind pass. Idle cost: one indexed read that returns nothing.
 */
import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import type { Deps } from "../../context";
import { dataMoves, members, users } from "../../db/schema";
import type { SuiteActor } from "../suite/common";
import { dropKeptFile, parseMeta, readKeptInput, readKeptMessages } from "./kept-file";

export const KEPT_IDLE_MIN = 2;
export const CONTINUE_LIMIT = 2;
export const CONTINUE_STEPS = 3;
export const MBOX_CONTINUE_BATCHES = 3;

type Row = typeof dataMoves.$inferSelect;

/** The person who started the run, if they are still an owner or admin of the workspace. */
async function starter(deps: Deps, m: Row): Promise<SuiteActor | null> {
  if (!m.createdByUserId) return null;
  const r = await deps.db.select({ role: members.role, email: users.email, name: users.name }).from(members).innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, m.orgId), eq(members.userId, m.createdByUserId))).get();
  if (!r || (r.role !== "owner" && r.role !== "admin")) return null;
  return { orgId: m.orgId, userId: m.createdByUserId, email: r.email, name: r.name, role: r.role };
}

export async function continueKeptMoves(deps: Deps) {
  if (!deps.importFiles) return { checked: 0, continued: 0, finished: 0 };
  const now = deps.now();
  const before = new Date(now.getTime() - KEPT_IDLE_MIN * 60_000);
  const rows = await deps.db.select().from(dataMoves)
    .where(and(inArray(dataMoves.status, ["running", "stopped"]), lt(dataMoves.lastStepAt, before), isNotNull(dataMoves.fileKey), eq(dataMoves.kind, "import")))
    .orderBy(dataMoves.lastStepAt).limit(CONTINUE_LIMIT);
  let continued = 0, finished = 0;
  const { runMoveStep } = await import("./service");
  const { importMboxBatch, MBOX_BATCH } = await import("./mbox");
  for (const m of rows) {
    if (m.fileExpiresAt && m.fileExpiresAt.getTime() <= now.getTime()) { await dropKeptFile(deps, m); continue; }
    // Essential write: the claim (only if no step ran since the read).
    const claimed = await deps.db.update(dataMoves).set({ lastStepAt: now }).where(and(eq(dataMoves.id, m.id), lt(dataMoves.lastStepAt, before))).returning({ id: dataMoves.id });
    if (!claimed.length) continue;
    const actor = await starter(deps, m);
    if (!actor) { await dropKeptFile(deps, m); continue; }
    continued++;
    try {
      if (m.source === "mail:mbox") {
        const meta = parseMeta(m.fileMeta);
        if (!meta) { await dropKeptFile(deps, m); continue; }
        let done = m.done;
        for (let b = 0; b < MBOX_CONTINUE_BATCHES && done < m.total; b++) {
          const msgs = await readKeptMessages(deps, m, done, MBOX_BATCH);
          if (!msgs || !msgs.length) break;
          const last = done + msgs.length >= m.total;
          const r = await importMboxBatch(deps, actor, { mailboxId: meta.mailboxId, moveId: m.id, fileName: m.fileName ?? undefined, total: m.total, folder: meta.folder, messages: msgs, last });
          done = r.move.done;
          if (r.move.status !== "running") { if (r.move.status === "done") finished++; break; }
        }
      } else {
        const input = await readKeptInput(deps, m);
        if (!input) { await dropKeptFile(deps, m); continue; }
        for (let s = 0; s < CONTINUE_STEPS; s++) {
          const r = await runMoveStep(deps, actor, { ...(input as object), moveId: m.id } as never);
          if (r.move.status === "done") { finished++; break; }
          if (r.stopped && r.stopped !== "time") break; // the day's cap or the write budget: carry on next pass or tomorrow
        }
      }
    } catch (err) {
      deps.log?.warn("data_move.continue_failed", { moveId: m.id, error: err });
    }
  }
  return { checked: rows.length, continued, finished };
}
