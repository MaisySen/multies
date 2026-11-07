/**
 * R85: mail rules (several actions in order, a run log, a test on recent mail) and thread labels, for the web app.
 *   /api/mail/rules         the person's rules; /test; /:id/runs; /:id/run-recent
 *   /api/mail/labels        labels with thread counts; add or remove a label on a thread
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, parseQuery, requireAuth } from "../middleware";
import { mailboxScope } from "../services/team";
import { addLabel, createRule, deleteRule, getRule, listLabels, listRules, listRuns, removeLabel, runOnRecent, testRule, updateRule } from "../services/mail/rules-r85";
import { LABEL_MAX, MailRuleInput, MailRulePatch, MailRuleTest } from "@/shared/mail-rules-r85";

const LabelBody = z.object({ threadId: z.string().min(1).max(128), label: z.string().trim().min(1).max(LABEL_MAX) });

export function mailRuleRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json({ rules: await listRules(c.var.deps, c.var.auth) }))
    .post("/", async (c) => c.json({ rule: await createRule(c.var.deps, c.var.auth, await mailboxScope(c.var.deps.db, c.var.auth), await parseBody(c, MailRuleInput)) }, 201))
    .post("/test", async (c) => c.json(await testRule(c.var.deps, c.var.auth, await mailboxScope(c.var.deps.db, c.var.auth), await parseBody(c, MailRuleTest))))
    .get("/:id", async (c) => c.json({ rule: await getRule(c.var.deps, c.var.auth, c.req.param("id")) }))
    .get("/:id/runs", async (c) => c.json({ runs: await listRuns(c.var.deps, c.var.auth, c.req.param("id")) }))
    .post("/:id/run-recent", async (c) => c.json(await runOnRecent(c.var.deps, c.var.auth, await mailboxScope(c.var.deps.db, c.var.auth), c.req.param("id"))))
    .patch("/:id", async (c) => c.json({ rule: await updateRule(c.var.deps, c.var.auth, await mailboxScope(c.var.deps.db, c.var.auth), c.req.param("id"), await parseBody(c, MailRulePatch)) }))
    .delete("/:id", async (c) => c.json(await deleteRule(c.var.deps, c.var.auth, c.req.param("id"))));
}

export function mailLabelRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json({ labels: await listLabels(c.var.deps, c.var.auth.orgId, await mailboxScope(c.var.deps.db, c.var.auth)) }))
    .post("/", async (c) => {
      const b = await parseBody(c, LabelBody);
      return c.json(await addLabel(c.var.deps, c.var.auth, await mailboxScope(c.var.deps.db, c.var.auth, "reply"), b.threadId, b.label)); // PRIV1a: a read only share can't label
    })
    .delete("/", async (c) => {
      const b = parseQuery(c, LabelBody);
      return c.json(await removeLabel(c.var.deps, c.var.auth, await mailboxScope(c.var.deps.db, c.var.auth, "reply"), b.threadId, b.label));
    });
}
