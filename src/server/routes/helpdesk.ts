/**
 * R119: helpdesk mode and the website chat.
 *   /api/helpdesk/*         settings, tickets, macros and website chats for the team (signed in)
 *   /api/widget/<key>/*     the website chat for visitors (public, CORS for the allowed domains only)
 *   /widget.js              the script a workspace pastes on its site
 *   /csat/<token>           the one tap survey after a ticket is solved
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, parseQuery, requireAuth } from "../middleware";
import { RateLimiter } from "../lib/rate-limit";
import { HttpError, tooMany } from "../lib/errors";
import {
  CSAT_LABEL, CSAT_RATINGS, HelpdeskSettingsPatch, MacroInput, TICKET_KINDS, TICKET_PRIORITIES, TICKET_STATUSES, TICKET_VIEWS, originAllowed, type CsatRating,
} from "@/shared/helpdesk";
import {
  addToContacts, agentTyping, deleteMacro, getSettings, getTicket, listMacros, listTickets, markTicketRead, patchTicket, rateSurvey, rotateWidgetKey, runMacro,
  saveMacro, saveSettings, startChat, surveyByToken, ticketByRef, visitorEmail, visitorPoll, visitorRate, visitorSend, visitorTyping, webReply, webThread,
  widgetConfig, widgetContext,
} from "../services/helpdesk";
import { suggestArticles } from "../services/help-center"; // R122
import { WIDGET_JS } from "./widget-script";

const ListQ = z.object({ view: z.enum(TICKET_VIEWS).optional(), priority: z.enum(TICKET_PRIORITIES).optional(), kind: z.enum(TICKET_KINDS).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });
const RefQ = z.object({ kind: z.enum(TICKET_KINDS), ref: z.string().min(1).max(128) });
const Patch = z.object({ status: z.enum(TICKET_STATUSES).optional(), priority: z.enum(TICKET_PRIORITIES).optional(), assigneeUserId: z.string().max(64).nullable().optional() });
const Reply = z.object({ text: z.string().min(1).max(4000), note: z.boolean().optional() });

export function helpdeskRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/settings", async (c) => c.json(await getSettings(c.var.deps, c.var.auth)))
    .patch("/settings", async (c) => c.json(await saveSettings(c.var.deps, c.var.auth, await parseBody(c, HelpdeskSettingsPatch))))
    .post("/settings/widget-key", async (c) => c.json(await rotateWidgetKey(c.var.deps, c.var.auth)))
    .get("/tickets", async (c) => c.json(await listTickets(c.var.deps, c.var.auth, parseQuery(c, ListQ))))
    .get("/tickets/by-ref", async (c) => { const q = parseQuery(c, RefQ); return c.json(await ticketByRef(c.var.deps, c.var.auth, q.kind, q.ref)); })
    .get("/tickets/:id", async (c) => c.json(await getTicket(c.var.deps, c.var.auth, c.req.param("id"))))
    .patch("/tickets/:id", async (c) => c.json(await patchTicket(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, Patch))))
    .post("/tickets/:id/read", async (c) => c.json(await markTicketRead(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/tickets/:id/contact", async (c) => c.json(await addToContacts(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/tickets/:id/macros/:macroId", async (c) => c.json(await runMacro(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("macroId"))))
    .get("/tickets/:id/web", async (c) => c.json(await webThread(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/tickets/:id/web", async (c) => { const b = await parseBody(c, Reply); return c.json(await webReply(c.var.deps, c.var.auth, c.req.param("id"), b.text, b.note)); })
    .post("/tickets/:id/typing", async (c) => c.json(await agentTyping(c.var.deps, c.var.auth, c.req.param("id"))))
    .get("/macros", async (c) => c.json({ macros: await listMacros(c.var.deps, c.var.auth) }))
    .post("/macros", async (c) => c.json({ macro: await saveMacro(c.var.deps, c.var.auth, await parseBody(c, MacroInput)) }, 201))
    .patch("/macros/:id", async (c) => c.json({ macro: await saveMacro(c.var.deps, c.var.auth, await parseBody(c, MacroInput), c.req.param("id")) }))
    .delete("/macros/:id", async (c) => c.json(await deleteMacro(c.var.deps, c.var.auth, c.req.param("id"))));
}

// ---------- website chat (public) ----------

const Start = z.object({ name: z.string().max(200).optional(), email: z.string().max(254).optional(), text: z.string().max(5000), page: z.string().max(2000).optional(), hp: z.string().max(200).optional(), offline: z.boolean().optional() });
const Send = z.object({ text: z.string().max(5000) });
const Email = z.object({ email: z.string().max(254), name: z.string().max(200).optional() });
const Rate = z.object({ rating: z.enum(CSAT_RATINGS) });
const AfterQ = z.object({ after: z.coerce.number().int().min(0).optional() });

/** Per IP, per isolate (a public call costs no limiter write; the per chat window is in the database). */
const limits = {
  start: new RateLimiter(20, 60 * 60_000),
  send: new RateLimiter(60, 60_000),
  poll: new RateLimiter(150, 60_000),
  typing: new RateLimiter(60, 60_000),
  other: new RateLimiter(30, 60_000),
};
function guard(c: Context<AppEnv>, l: RateLimiter) {
  if (!l.take(`${c.var.ip}:${c.req.param("key")}`)) throw tooMany("Too many messages in a short time. Wait a moment and try again.");
}
const token = (c: Context<AppEnv>) => c.req.header("x-visitor-token");
const ctx = (c: Context<AppEnv>) => widgetContext(c.var.deps, c.req.param("key") ?? "", c.req.header("origin"));

export function widgetRoutes() {
  return new Hono<AppEnv>()
    // CORS for the workspace's allowed domains: the answer names the caller's origin only after the key and origin check.
    .use("/:key/*", async (c, next) => {
      const origin = c.req.header("origin") ?? null;
      let allowed = false;
      if (origin) {
        try { const w = await ctx(c); allowed = originAllowed(origin, w.settings.widget.domains, [c.var.deps.config.appUrl]); } catch { allowed = false; }
      }
      if (c.req.method === "OPTIONS") {
        if (!allowed) return c.body(null, 403);
        return c.body(null, 204, {
          "access-control-allow-origin": origin!, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type, x-visitor-token",
          "access-control-max-age": "600", vary: "Origin",
        });
      }
      await next();
      if (allowed) { c.res.headers.set("access-control-allow-origin", origin!); c.res.headers.append("vary", "Origin"); }
    })
    .get("/:key/config", async (c) => { guard(c, limits.poll); return c.json(await widgetConfig(c.var.deps, await ctx(c))); })
    // R122: up to 3 help center articles for what the visitor is typing (empty unless HELP_CENTER and the workspace's setting are on).
    .get("/:key/help", async (c) => {
      guard(c, limits.poll);
      const w = await ctx(c);
      if (!c.var.deps.config.helpCenter) return c.json({ articles: [] });
      return c.json({ articles: await suggestArticles(c.var.deps, w.row.orgId, (c.req.query("q") ?? "").slice(0, 200)) });
    })
    .post("/:key/chats", async (c) => { guard(c, limits.start); return c.json(await startChat(c.var.deps, await ctx(c), await parseBody(c, Start)), 201); })
    .get("/:key/chats/me", async (c) => { guard(c, limits.poll); return c.json(await visitorPoll(c.var.deps, await ctx(c), token(c), parseQuery(c, AfterQ).after ?? 0)); })
    .post("/:key/chats/me/messages", async (c) => { guard(c, limits.send); return c.json(await visitorSend(c.var.deps, await ctx(c), token(c), (await parseBody(c, Send)).text)); })
    .post("/:key/chats/me/typing", async (c) => { guard(c, limits.typing); return c.json(await visitorTyping(c.var.deps, await ctx(c), token(c))); })
    .post("/:key/chats/me/email", async (c) => { guard(c, limits.other); const b = await parseBody(c, Email); return c.json(await visitorEmail(c.var.deps, await ctx(c), token(c), b.email, b.name)); })
    .post("/:key/chats/me/rating", async (c) => { guard(c, limits.other); return c.json(await visitorRate(c.var.deps, await ctx(c), token(c), (await parseBody(c, Rate)).rating)); });
}

export const WIDGET_JS_HEADERS: Record<string, string> = {
  "content-type": "application/javascript; charset=utf-8",
  "cache-control": "public, max-age=3600",
  "cross-origin-resource-policy": "cross-origin",
  "x-content-type-options": "nosniff",
};
export function widgetScriptRoutes() {
  return new Hono<AppEnv>().get("/", (c) => c.body(WIDGET_JS, 200, WIDGET_JS_HEADERS));
}

// ---------- survey (public) ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const surveyLimiter = new RateLimiter(30, 60_000);
const CSS = `<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#111827;--muted:#4b5563;--line:#e5e7eb;--brand:#4338ca}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--fg:#f3f4f6;--muted:#a1a1aa;--line:#2a2f3a;--brand:#a5b4fc}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:grid;place-items:center;min-height:100dvh;padding:16px}
main{background:var(--card);border:1px solid var(--line);border-radius:16px;max-width:440px;width:100%;padding:28px}
h1{font-size:20px;margin:0 0 6px}p{margin:0 0 16px;color:var(--muted)}
.opts{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:0 0 16px}
button{font:inherit;min-height:48px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;padding:8px}
button:hover{border-color:var(--brand)}button:focus-visible,textarea:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
button[aria-pressed=true]{border-color:var(--brand);box-shadow:inset 0 0 0 1px var(--brand)}
.send{width:100%;background:var(--brand);border-color:var(--brand);color:#fff;font-weight:600}
@media (prefers-color-scheme:dark){.send{color:#111827}}
label{display:block;font-size:14px;font-weight:600;margin:0 0 6px}textarea{width:100%;min-height:88px;font:inherit;border:1px solid var(--line);border-radius:10px;padding:10px;background:var(--card);color:var(--fg);margin:0 0 16px}
@media (prefers-reduced-motion:no-preference){button{transition:border-color .15s}}
</style>`;
function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>${CSS}</head><body><main>${body}</main></body></html>`;
}
function form(tokenStr: string, chosen: CsatRating | null, workspace: string) {
  const opts = CSAT_RATINGS.map((r) => `<button type="submit" name="rating" value="${r}" aria-pressed="${chosen === r}">${CSAT_LABEL[r]}</button>`).join("");
  return page("How did we do?", `<h1>How did ${esc(workspace || "we")} do?</h1><p>Pick one. You can add a comment too.</p>
<form method="post" action="/csat/${esc(tokenStr)}"><div class="opts" role="group" aria-label="Your rating">${opts}</div>
<label for="c">Comment (optional)</label><textarea id="c" name="comment" maxlength="1000"></textarea>
<button class="send" type="submit" name="rating" value="${chosen ?? "great"}">${chosen ? `Send ${CSAT_LABEL[chosen].toLowerCase()}` : "Send"}</button></form>`);
}
const thanks = (workspace: string, comment: boolean) => page("Thank you", `<h1>Thank you</h1><p>${comment ? "Your rating and comment" : "Your rating"} reached ${esc(workspace || "the team")}. You can close this page.</p>`);
const gone = () => page("Survey not found", "<h1>This survey is no longer open</h1><p>The link may be old. If you still need help, reply to the last mail from the team.</p>");

export function surveyRoutes() {
  return new Hono<AppEnv>()
    .get("/:token", async (c) => {
      if (!surveyLimiter.take(c.var.ip)) return c.html(page("Too many requests", "<h1>Too many requests</h1><p>Try again in a minute.</p>"), 429);
      const found = await surveyByToken(c.var.deps, c.req.param("token"));
      if (!found) return c.html(gone(), 404);
      const r = c.req.query("r") as CsatRating | undefined;
      const chosen = r && (CSAT_RATINGS as readonly string[]).includes(r) ? r : null;
      // One tap: a real tap on the link in the mail records the rating. Mail scanners that open links never send Sec-Fetch-User.
      if (chosen && c.req.header("sec-fetch-user") === "?1" && c.req.header("sec-fetch-mode") === "navigate") {
        await rateSurvey(c.var.deps, c.req.param("token"), chosen);
        return c.html(page("Thank you", `<h1>Thank you</h1><p>You rated us ${esc(CSAT_LABEL[chosen].toLowerCase())}. Want to say more?</p>
<form method="post" action="/csat/${esc(c.req.param("token"))}"><input type="hidden" name="rating" value="${chosen}"><label for="c">Comment (optional)</label><textarea id="c" name="comment" maxlength="1000"></textarea><button class="send" type="submit">Send comment</button></form>`));
      }
      return c.html(form(c.req.param("token"), chosen, found.workspace));
    })
    .post("/:token", async (c) => {
      if (!surveyLimiter.take(c.var.ip)) return c.html(page("Too many requests", "<h1>Too many requests</h1><p>Try again in a minute.</p>"), 429);
      const b = await c.req.parseBody();
      const rating = String(b.rating ?? "") as CsatRating;
      if (!(CSAT_RATINGS as readonly string[]).includes(rating)) return c.html(form(c.req.param("token"), null, ""), 400);
      const comment = typeof b.comment === "string" ? b.comment : null;
      try {
        const r = await rateSurvey(c.var.deps, c.req.param("token"), rating, comment);
        return c.html(thanks(r.workspace, !!comment?.trim()));
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) return c.html(gone(), 404);
        throw e;
      }
    });
}
