/**
 * TD3 (MEET_TD3): meetings to tasks, mounted at /api/meeting-td3 (web app, cookie session). With the flag off every
 * path is 404 before auth, exactly as before the round. Anyone in the workspace who can open the meeting reads its
 * suggestions; only people write. No request or response body is logged here.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { notFound } from "../lib/errors";
import { acceptAll, acceptSuggestion, addSuggestion, discardSuggestion, editSuggestion, followUp, meetingSuggestionsView, meetTd3Enabled, sourceText, suggest, undoSuggestions } from "../services/suite/meeting-suggestions-td3";

const Id = z.string().min(1).max(100);
const Due = z.string().max(10).nullable().optional();
export const SuggestIn = z.object({ source: z.enum(["recording", "notes", "pasted"]), recordingId: Id.nullable().optional(), text: z.string().max(200 * 1024).nullable().optional() });
export const AddIn = z.object({ title: z.string().min(1).max(300), quote: z.string().max(2000).nullable().optional(), assigneeId: Id.nullable().optional(), due: Due, accept: z.boolean().optional(), projectId: Id.nullable().optional() });
export const EditIn = z.object({ title: z.string().min(1).max(300).optional(), assigneeId: Id.nullable().optional(), due: Due });
const AcceptIn = z.object({ projectId: Id.nullable().optional() });
const AcceptAllIn = z.object({ ids: z.array(Id).max(50).optional(), projectId: Id.nullable().optional() });
const UndoIn = z.object({ ids: z.array(Id).min(1).max(50) });

export function meetingTd3Routes() {
  return new Hono<AppEnv>()
    .use("*", async (c, next) => { if (!meetTd3Enabled(c.var.deps)) throw notFound("Page"); await next(); })
    .use("*", requireAuth)
    .get("/:id", async (c) => c.json(await meetingSuggestionsView(c.var.deps, c.var.auth, c.req.param("id"))))
    .get("/:id/source", async (c) => {
      const kind = c.req.query("source") === "notes" ? "notes" : "recording";
      return c.json(await sourceText(c.var.deps, c.var.auth, c.req.param("id"), { source: kind, recordingId: c.req.query("recordingId") || null }));
    })
    .get("/:id/follow-up", async (c) => c.json(await followUp(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/:id/suggest", async (c) => c.json(await suggest(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, SuggestIn))))
    .post("/:id/suggestions", async (c) => c.json(await addSuggestion(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, AddIn))))
    .patch("/:id/suggestions/:sid", async (c) => c.json(await editSuggestion(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("sid"), await parseBody(c, EditIn))))
    .post("/:id/suggestions/:sid/accept", async (c) => c.json(await acceptSuggestion(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("sid"), await parseBody(c, AcceptIn))))
    .post("/:id/suggestions/:sid/discard", async (c) => c.json(await discardSuggestion(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("sid"))))
    .post("/:id/accept-all", async (c) => c.json(await acceptAll(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, AcceptAllIn))))
    .post("/:id/undo", async (c) => c.json(await undoSuggestions(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, UndoIn)).ids)));
}
