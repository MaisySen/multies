/**
 * R109 (flag merge_plus_r109): lists with consent, newsletters and journeys under /api/tools/campaigns,
 * and the public pages under /api/campaign-public (one click unsubscribe, open and click counts, signup
 * form with double opt in). Public routes use no cookies; a random token or signed key is the only key.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { forbidden } from "../lib/errors";
import { audit } from "../services/audit";
import { requireToolFeature } from "../services/tools/features";
import { toolStateOrOff } from "../services/tools/automation";
import { suppress } from "../services/deliverability/suppressions";
import * as C from "../services/campaigns/r109";
import { CONSENT_SOURCES, LIST_NAME_MAX, blocksSchema, escapeHtml, journeyStepsSchema, WELCOME_SERIES } from "@/shared/campaigns-r109";

const listSchema = z.object({
  name: z.string().trim().min(1, "Give the list a name").max(LIST_NAME_MAX), description: z.string().max(500).optional(),
  visibility: z.enum(["workspace", "private"]).optional(), doubleOptIn: z.boolean().optional(), allowInferred: z.boolean().optional(), signupOn: z.boolean().optional(),
  mailboxId: z.string().max(64).nullable().optional(), senderName: z.string().max(120).optional(), senderAddress: z.string().max(300).optional(), tz: z.string().max(64).optional(),
});
const consentSchema = z.object({ kind: z.enum(["express", "inferred"]), source: z.string().trim().min(1, "Say where they gave consent").max(200) });
const personSchema = z.object({ email: z.string().max(254), name: z.string().max(200).optional(), fields: z.record(z.string(), z.string().max(500)).optional() });
const membersSchema = z.object({ people: z.array(personSchema).min(1).max(2000), consent: consentSchema });
const fromContactsSchema = z.object({ contactIds: z.union([z.array(z.string().max(64)).max(2000), z.literal("all")]), consent: consentSchema });
const campaignCreate = z.object({ listId: z.string().min(1).max(64), name: z.string().trim().min(1, "Give it a name").max(120) });
const campaignPatch = z.object({ name: z.string().max(120).optional(), subject: z.string().max(200).optional(), preheader: z.string().max(200).optional(), blocks: blocksSchema.optional(), track: z.boolean().optional(), listId: z.string().max(64).optional(), mailboxId: z.string().max(64).nullable().optional() });
const journeyCreate = z.object({ listId: z.string().min(1).max(64), name: z.string().trim().min(1, "Give it a name").max(120), starter: z.enum(["welcome", "blank"]).default("welcome") });
const journeyPatch = z.object({ name: z.string().max(120).optional(), steps: journeyStepsSchema.optional(), sendHour: z.number().int().min(0).max(23).optional(), mailboxId: z.string().max(64).nullable().optional() });

async function on(c: Context<AppEnv>) {
  requireToolFeature(c, "merge_plus_r109");
  await toolStateOrOff(c.var.deps, c.var.auth.orgId);
  return { deps: c.var.deps, auth: c.var.auth };
}
const log = (c: Context<AppEnv>, action: string, targetType: string, targetId: string, metadata: Record<string, unknown> = {}) =>
  audit(c.var.deps.db, { orgId: c.var.auth.orgId, actorUserId: c.var.auth.userId, actorEmail: c.var.auth.email, action, targetType, targetId, metadata });

export function campaignRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/info", async (c) => { const { deps, auth } = await on(c); return c.json({ ...(await C.sendInfo(deps, auth)), consentSources: CONSENT_SOURCES, isAdmin: C.isAdmin(auth) }); })
    // lists
    .get("/lists", async (c) => { const { deps, auth } = await on(c); return c.json({ lists: await C.listLists(deps, auth) }); })
    .post("/lists", async (c) => { const { deps, auth } = await on(c); const l = await C.createList(deps, auth, await parseBody(c, listSchema)); await log(c, "campaigns.list_created", "audience_list", l.id); return c.json(l, 201); })
    .get("/lists/:id", async (c) => {
      const { deps, auth } = await on(c);
      const q = c.req.query();
      return c.json(await C.listMembers(deps, auth, c.req.param("id"), { search: q.q, status: q.status && ["pending", "subscribed", "unsubscribed", "bounced", "complained"].includes(q.status) ? q.status : undefined, offset: Number(q.offset ?? 0) || 0 }));
    })
    .patch("/lists/:id", async (c) => { const { deps, auth } = await on(c); return c.json(await C.updateList(deps, auth, c.req.param("id"), await parseBody(c, listSchema.partial()))); })
    .delete("/lists/:id", async (c) => { const { deps, auth } = await on(c); await C.archiveList(deps, auth, c.req.param("id")); await log(c, "campaigns.list_archived", "audience_list", c.req.param("id")); return c.json({ ok: true }); })
    .post("/lists/:id/members", async (c) => {
      const { deps, auth } = await on(c); const b = await parseBody(c, membersSchema);
      const r = await C.addMembers(deps, auth, c.req.param("id"), b.people, b.consent, b.people.length > 1 ? "import" : "manual");
      await log(c, "campaigns.members_added", "audience_list", c.req.param("id"), { ...r, consent: b.consent.kind, source: b.consent.source });
      return c.json(r);
    })
    .post("/lists/:id/members/contacts", async (c) => {
      const { deps, auth } = await on(c); const b = await parseBody(c, fromContactsSchema);
      const r = await C.addFromContacts(deps, auth, c.req.param("id"), b.contactIds, b.consent);
      await log(c, "campaigns.members_added", "audience_list", c.req.param("id"), { ...r, from: "contacts", consent: b.consent.kind, source: b.consent.source });
      return c.json(r);
    })
    .delete("/lists/:id/members/:mid", async (c) => { const { deps, auth } = await on(c); await C.removeMember(deps, auth, c.req.param("id"), c.req.param("mid")); return c.json({ ok: true }); })
    // unsubscribes and blocked addresses
    .get("/suppressions", async (c) => { const { deps, auth } = await on(c); return c.json({ items: await C.suppressionList(deps, auth, c.req.query("q") ?? "") }); })
    .post("/suppressions", async (c) => {
      const { deps, auth } = await on(c);
      if (!C.isAdmin(auth)) throw forbidden("Only admins can block an address.");
      const b = await parseBody(c, z.object({ email: z.string().email("Enter a valid email address").max(254) }));
      await suppress(deps.db, auth.orgId, b.email, "manual", "Blocked from Merge");
      await C.unsubscribeEverywhere(deps, auth.orgId, b.email);
      await log(c, "campaigns.address_blocked", "suppression", b.email.toLowerCase());
      return c.json({ ok: true });
    })
    // newsletters
    .get("/newsletters", async (c) => { const { deps, auth } = await on(c); return c.json({ newsletters: await C.listCampaigns(deps, auth) }); })
    .post("/newsletters", async (c) => { const { deps, auth } = await on(c); return c.json(await C.createCampaign(deps, auth, await parseBody(c, campaignCreate)), 201); })
    .get("/newsletters/:id", async (c) => { const { deps, auth } = await on(c); return c.json(await C.getCampaign(deps, auth, c.req.param("id"))); })
    .patch("/newsletters/:id", async (c) => { const { deps, auth } = await on(c); return c.json(await C.updateCampaign(deps, auth, c.req.param("id"), await parseBody(c, campaignPatch))); })
    .delete("/newsletters/:id", async (c) => { const { deps, auth } = await on(c); await C.deleteCampaign(deps, auth, c.req.param("id")); return c.json({ ok: true }); })
    .post("/newsletters/:id/duplicate", async (c) => { const { deps, auth } = await on(c); return c.json(await C.duplicateCampaign(deps, auth, c.req.param("id")), 201); })
    .get("/newsletters/:id/preview", async (c) => { const { deps, auth } = await on(c); return c.json(await C.previewCampaign(deps, auth, c.req.param("id"))); })
    .post("/newsletters/:id/test", async (c) => { const { deps, auth } = await on(c); return c.json(await C.testSend(deps, auth, c.req.param("id"))); })
    .post("/newsletters/:id/schedule", async (c) => {
      const { deps, auth } = await on(c); const b = await parseBody(c, z.object({ at: z.string().max(40).nullable().default(null) }));
      const r = await C.scheduleCampaign(deps, auth, c.req.param("id"), b.at);
      await log(c, "campaigns.newsletter_scheduled", "campaign", r.id, { at: r.scheduledAt, list: r.listId });
      return c.json(r);
    })
    .post("/newsletters/:id/unschedule", async (c) => { const { deps, auth } = await on(c); return c.json(await C.unscheduleCampaign(deps, auth, c.req.param("id"))); })
    .post("/newsletters/:id/pause", async (c) => { const { deps, auth } = await on(c); return c.json(await C.pauseCampaign(deps, auth, c.req.param("id"), true)); })
    .post("/newsletters/:id/resume", async (c) => { const { deps, auth } = await on(c); return c.json(await C.pauseCampaign(deps, auth, c.req.param("id"), false)); })
    .post("/newsletters/:id/stop", async (c) => { const { deps, auth } = await on(c); const r = await C.stopCampaign(deps, auth, c.req.param("id")); await log(c, "campaigns.newsletter_stopped", "campaign", r.id); return c.json(r); })
    // journeys
    .get("/journeys", async (c) => { const { deps, auth } = await on(c); return c.json({ journeys: await C.listJourneys(deps, auth) }); })
    .post("/journeys", async (c) => { const { deps, auth } = await on(c); const b = await parseBody(c, journeyCreate); return c.json(await C.createJourney(deps, auth, { listId: b.listId, name: b.name, starter: b.starter === "welcome" ? WELCOME_SERIES : [] }), 201); })
    .get("/journeys/:id", async (c) => { const { deps, auth } = await on(c); return c.json(await C.getJourney(deps, auth, c.req.param("id"))); })
    .patch("/journeys/:id", async (c) => { const { deps, auth } = await on(c); return c.json(await C.updateJourney(deps, auth, c.req.param("id"), await parseBody(c, journeyPatch))); })
    .delete("/journeys/:id", async (c) => { const { deps, auth } = await on(c); await C.deleteJourney(deps, auth, c.req.param("id")); return c.json({ ok: true }); })
    .post("/journeys/:id/start", async (c) => { const { deps, auth } = await on(c); const r = await C.setJourneyStatus(deps, auth, c.req.param("id"), "active"); await log(c, "campaigns.journey_started", "journey", r.id); return c.json(r); })
    .post("/journeys/:id/pause", async (c) => { const { deps, auth } = await on(c); const r = await C.setJourneyStatus(deps, auth, c.req.param("id"), "paused"); await log(c, "campaigns.journey_paused", "journey", r.id); return c.json(r); });
}

// ------------------------------------------------------------------ public

const GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (ch) => ch.charCodeAt(0));
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>:root{color-scheme:light dark}body{font-family:system-ui,sans-serif;max-width:440px;margin:12vh auto;padding:0 20px;color:#1f2430;background:#fff}@media(prefers-color-scheme:dark){body{background:#14161b;color:#e8eaf0}input{background:#1d2027;color:#e8eaf0;border-color:#3a3f4b}}h1{font-size:24px;line-height:1.3}p,label{line-height:1.5}label{display:block;margin:12px 0 4px;font-weight:600}input[type=email],input[type=text]{width:100%;box-sizing:border-box;font:inherit;padding:10px 12px;border:1px solid #c9cdd6;border-radius:8px}.tick{display:flex;gap:8px;align-items:flex-start;font-weight:400}.tick input{margin-top:5px}button{font:inherit;margin-top:16px;padding:10px 18px;border-radius:8px;border:0;background:#2f5bea;color:#fff;cursor:pointer}.hp{position:absolute;left:-9999px}small{color:#6b7280}</style></head><body><main>${body}</main></body></html>`;

export function campaignPublicRoutes() {
  return new Hono<AppEnv>()
    .use("*", async (c, next) => { c.header("cache-control", "no-store"); c.header("referrer-policy", "no-referrer"); await next(); })
    .get("/o/:file", async (c) => {
      const token = c.req.param("file").replace(/\.gif$/, "");
      if (/^[0-9a-f]{32}$/.test(token)) await C.recordOpen(c.var.deps, token).catch(() => {});
      return c.body(GIF, 200, { "content-type": "image/gif" });
    })
    .get("/c/:token", async (c) => {
      const token = c.req.param("token"); const u = c.req.query("u") ?? ""; const s = c.req.query("s") ?? "";
      if (!/^https:\/\//i.test(u) || !(await C.checkLinkSig(c.var.deps, token, u, s))) return c.html(page("Link not valid", "<h1>This link isn't valid</h1><p>It may have been cut short.</p>"), 400);
      await C.recordClick(c.var.deps, token).catch(() => {});
      return c.redirect(u, 302);
    })
    .get("/u/:token", async (c) => {
      const token = c.req.param("token");
      if (token === "preview" || token === "test") return c.html(page("Unsubscribe", "<h1>Unsubscribe</h1><p>This is a preview. In a real email this link unsubscribes the person at once.</p>"));
      const r = await C.recipientByToken(c.var.deps, token);
      if (!r) return c.html(page("Link not valid", "<h1>This link isn't valid</h1><p>Reply to the email and ask to be taken off the list.</p>"), 400);
      return c.html(page("Unsubscribe", `<h1>Unsubscribe</h1><p>Stop getting these emails at ${escapeHtml(r.email)}?</p><form method="post" action="/api/campaign-public/u/${token}"><button type="submit">Unsubscribe</button></form>`));
    })
    // One click (RFC 8058: mail apps POST "List-Unsubscribe=One-Click") and the page's button.
    .post("/u/:token", async (c) => {
      const r = await C.unsubscribeByToken(c.var.deps, c.req.param("token"));
      if (!r) return c.html(page("Link not valid", "<h1>This link isn't valid</h1><p>Reply to the email and ask to be taken off the list.</p>"), 400);
      return c.html(page("Unsubscribed", `<h1>You're unsubscribed</h1><p>${escapeHtml(r.email)} won't get these emails again.</p>`));
    })
    .get("/s/:key", async (c) => {
      const l = await C.signupList(c.var.deps, c.req.param("key"));
      if (!l) return c.html(page("Not found", "<h1>This signup form is closed</h1>"), 404);
      const who = escapeHtml(l.sender_name || l.name);
      return c.html(page(l.name, `<h1>${escapeHtml(l.name)}</h1>${l.description ? `<p>${escapeHtml(l.description)}</p>` : ""}<form method="post" action="/api/campaign-public/s/${escapeHtml(l.signup_key)}">
<label for="n">Name</label><input id="n" name="name" type="text" autocomplete="name" maxlength="200">
<label for="e">Email</label><input id="e" name="email" type="email" autocomplete="email" required maxlength="254">
<input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
<label class="tick"><input type="checkbox" name="consent" value="1" required> Yes, send me emails from ${who}. I can unsubscribe at any time.</label>
<button type="submit">Sign up</button></form><p><small>${who}, ${escapeHtml(l.sender_address)}</small></p>`));
    })
    .post("/s/:key", async (c) => {
      const l = await C.signupList(c.var.deps, c.req.param("key"));
      if (!l) return c.html(page("Not found", "<h1>This signup form is closed</h1>"), 404);
      const b = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
      if (String(b.website ?? "")) return c.html(page("Thanks", "<h1>Thanks</h1>")); // honeypot
      if (String(b.consent ?? "") !== "1") return c.html(page("Tick the box", "<h1>Tick the box to sign up</h1><p>We only send emails to people who say yes. Go back and tick the box.</p>"), 400);
      try {
        const r = await C.signupSubmit(c.var.deps, l, { email: String(b.email ?? ""), name: String(b.name ?? "") });
        if (r.status === "confirm") return c.html(page("Check your inbox", "<h1>Check your inbox</h1><p>We sent you an email. Open it and confirm to finish signing up.</p>"));
        if (r.status === "blocked") return c.html(page("Can't sign up", "<h1>We can't add this address</h1><p>Emails to it bounced or were marked as spam before. Reply to one of our emails to sort it out.</p>"), 400);
        return c.html(page("You're in", "<h1>You're signed up</h1><p>Thanks. You can unsubscribe from any email.</p>"));
      } catch {
        return c.html(page("Check the address", "<h1>Check your email address</h1><p>Go back and enter a valid email address.</p>"), 400);
      }
    })
    .get("/confirm/:token", (c) => c.html(page("Confirm", `<h1>Confirm your signup</h1><p>One more tap and you're on the list.</p><form method="post" action="/api/campaign-public/confirm/${escapeHtml(c.req.param("token").replace(/[^0-9a-f]/g, ""))}"><button type="submit">Confirm</button></form>`)))
    .post("/confirm/:token", async (c) => {
      const m = await C.confirmSignup(c.var.deps, c.req.param("token"));
      if (!m) return c.html(page("Link used", "<h1>This link was used or has expired</h1><p>If you're not getting emails yet, sign up again.</p>"), 400);
      return c.html(page("Confirmed", `<h1>You're confirmed</h1><p>${escapeHtml(m.email)} is on the list. You can unsubscribe from any email.</p>`));
    });
}
