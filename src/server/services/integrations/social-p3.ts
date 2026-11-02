/**
 * R132: Social P3 (flag SOCIAL_P3_R132). YouTube comments in the Social inbox and YouTube and Pinterest rows in account
 * health (both through the platform's signed proxy, the same way the Oct 31 hotfix reaches Facebook and LinkedIn),
 * best times to post from the workspace's own results, writing help on the free AI tier R110 Ask uses (Workers AI
 * only, never a workspace key) and the Snapchat share page. YouTube upload and Google Business Profile posts sit
 * behind held sub flags (see src/shared/social-p3.ts for why). Nothing here logs tokens, media links or message text.
 */
import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { socialPostStats, socialPostTargets, socialSlots } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { PublishError, proxyCall, type PublishCtx } from "./social";
import { adjustRow, CHAT_MODEL, estimateTokens, planOf, reserve, reserveRow, unitsFor } from "../tools/ai-meter";
import { isAskExcluded } from "../ask-r110";
import {
  BEST_DAYS, WRITE_DAILY, WRITE_ERROR_MESSAGE, WRITE_GLOBAL_UNITS, WRITE_LIMIT_MESSAGE, WRITE_TEXT_MAX, bestSlots, cleanRewrite, fitText,
  isHttpsLink, writePrompt, type BestTimesResponse, type P3Flags, type WriteAction,
} from "@/shared/social-p3";
import { NETWORK_RULES } from "@/shared/social-p2";
import { assertAiAllowed } from "../ai-trust-td1"; // TD1: AI trust gate

export function p3Flags(deps: Deps): P3Flags {
  const p3 = deps.config.socialP3R132 === true;
  return { p3, youtubeUpload: p3 && deps.config.socialYoutubeUploadR132 === true, gbp: p3 && deps.config.socialGbpR132 === true };
}
export function requireP3(deps: Deps) {
  if (deps.config.socialP3R132 !== true) throw new HttpError(404, "not_found", "Not found.");
}

/* ---------------------------------------------------------------- network calls through the signed proxy */

const YT = "https://www.googleapis.com/youtube/v3";

/** One proxied call, with the network's answer turned into our codes (reconnect, no_permission, rate_limited...). */
export async function netCall(ctx: PublishCtx, method: "GET" | "POST", endpoint: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await proxyCall(ctx, { endpoint, method, ...(body ? { body } : {}) });
  const data = (res.data && typeof res.data === "object" ? res.data : {}) as Record<string, unknown>;
  if (res.status < 400) return data;
  const err = (data.error && typeof data.error === "object" ? data.error : {}) as { message?: unknown; errors?: { reason?: unknown }[] };
  const reason = String(err.errors?.[0]?.reason ?? "");
  if (res.status === 401) throw new PublishError("reconnect", "signed out");
  if (res.status === 403 && /insufficient|forbidden|scope/i.test(reason + String(err.message ?? ""))) throw new PublishError("no_permission", "permission");
  if (res.status === 403 && /disabled/i.test(reason)) throw new PublishError("rejected", "Comments are turned off on this video.");
  if (res.status === 429 || /quota|rateLimit/i.test(reason)) throw new PublishError("rate_limited", "limit");
  if (res.status >= 500) throw new PublishError("unavailable", "network down");
  const msg = typeof err.message === "string" ? err.message.replace(/<[^>]*>/g, "").slice(0, 200) : `error ${res.status}`;
  throw new PublishError("rejected", msg);
}

const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const o = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);

/** The signed in channel's id (YouTube answers an empty list for an account with no channel). */
export async function youtubeChannel(ctx: PublishCtx): Promise<string | null> {
  const r = await netCall(ctx, "GET", `${YT}/channels?part=id&mine=true`);
  return s(arr(r.items)[0]?.id);
}

/** YouTube health: the sign in works, a channel exists, and the comment permission was granted. */
export async function youtubeHealth(ctx: PublishCtx, scope: string | null): Promise<string | null> {
  const ch = await youtubeChannel(ctx);
  if (!ch) return "no_channel";
  if (scope && !/youtube\.force-ssl|auth\/youtube(,|\s|$)/.test(scope)) return "no_permission";
  return null;
}

/** Pinterest health: the sign in works and the account can be read. */
export async function pinterestHealth(ctx: PublishCtx): Promise<string | null> {
  await netCall(ctx, "GET", "https://api.pinterest.com/v5/user_account");
  return null;
}

export interface YtIncoming { remoteId: string; kind: "comment"; authorId: string | null; authorName: string | null; text: string; postUrl: string | null; postText: string | null; receivedAt: Date; inbound: boolean }

/** Maps one commentThreads answer to inbox items: the top comment of each thread (replies go to that comment). */
export function mapYoutubeThreads(data: unknown, channelId: string | null, now: Date): YtIncoming[] {
  const out: YtIncoming[] = [];
  for (const th of arr(o(data).items)) {
    const top = o(o(th.snippet).topLevelComment);
    const sn = o(top.snippet);
    const id = s(top.id);
    const text = s(sn.textOriginal) ?? s(sn.textDisplay)?.replace(/<[^>]*>/g, "") ?? null;
    if (!id || !text) continue;
    const author = s(o(sn.authorChannelId).value);
    const video = s(sn.videoId) ?? s(o(th.snippet).videoId);
    const t = Date.parse(String(sn.publishedAt ?? ""));
    out.push({
      remoteId: id, kind: "comment", authorId: author, authorName: s(sn.authorDisplayName), text: text.slice(0, 4000),
      postUrl: video ? `https://www.youtube.com/watch?v=${encodeURIComponent(video)}&lc=${encodeURIComponent(id)}` : null, postText: null,
      receivedAt: Number.isFinite(t) ? new Date(t) : now, inbound: !channelId || author !== channelId,
    });
  }
  return out;
}

/** The newest comment threads across the channel's videos (one read, 50 at most). */
export async function pullYoutube(ctx: PublishCtx, now: Date): Promise<YtIncoming[]> {
  const ch = await youtubeChannel(ctx);
  if (!ch) return [];
  const r = await netCall(ctx, "GET", `${YT}/commentThreads?part=snippet&allThreadsRelatedToChannelId=${encodeURIComponent(ch)}&maxResults=50&order=time&textFormat=plainText`);
  return mapYoutubeThreads(r, ch, now);
}

/** A reply under a top level YouTube comment. */
export function youtubeReplyBody(parentId: string, text: string) { return { snippet: { parentId, textOriginal: text } }; }
export async function replyYoutube(ctx: PublishCtx, parentId: string, text: string): Promise<void> {
  await netCall(ctx, "POST", `${YT}/comments?part=snippet`, youtubeReplyBody(parentId, text));
}

/* ---------------------------------------------------------------- best times */

async function workspaceTz(deps: Deps, orgId: string): Promise<string | null> {
  const row = await deps.db.select({ tz: socialSlots.tz }).from(socialSlots).where(eq(socialSlots.orgId, orgId)).limit(1).get();
  return row?.tz ?? null;
}

/**
 * The top 3 times to post for the networks picked (all when none), from this workspace's own results in the last
 * 90 days, in the workspace's time zone (its posting slots' zone; else the person's browser zone).
 */
export async function bestTimesFor(deps: Deps, auth: AuthContext, appsRaw: string | undefined, tzHint: string | undefined): Promise<BestTimesResponse> {
  requireP3(deps);
  const apps = (appsRaw ?? "").split(",").map((a) => a.trim()).filter((a) => /^[a-z_]{2,40}$/.test(a)).slice(0, 12);
  const since = new Date(deps.now().getTime() - BEST_DAYS * 86_400_000);
  const rows = await deps.db.select({ sentAt: socialPostTargets.sentAt, reach: socialPostStats.reach, engagement: socialPostStats.engagement })
    .from(socialPostStats)
    .innerJoin(socialPostTargets, and(eq(socialPostTargets.postId, socialPostStats.postId), eq(socialPostTargets.accountId, socialPostStats.accountId)))
    .where(and(eq(socialPostStats.orgId, auth.orgId), isNotNull(socialPostTargets.sentAt), gte(socialPostTargets.sentAt, since), ...(apps.length ? [inArray(socialPostStats.app, apps.slice(0, 12))] : []))) // D1: at most 12 network names
    .limit(2000).all();
  const tz = (await workspaceTz(deps, auth.orgId)) ?? tzHint ?? null;
  return bestSlots(rows.map((r) => ({ sentAt: (r.sentAt as Date).toISOString(), reach: r.reach, engagement: r.engagement })), tz, deps.now().getTime());
}

/* ---------------------------------------------------------------- writing help */

export const WRITE_ROW = (orgId: string) => `socialwrite:${orgId}`;
export const WRITE_GLOBAL_ROW = "socialwrite:*";
const WRITE_MAX_TOKENS = 500;

export interface WriteResult { text: string; texts?: Record<string, string>; left: number }

async function excluded(deps: Deps, orgId: string): Promise<boolean> {
  const [org] = await deps.db.all<{ id: string; slug: string | null; name: string | null }>(sql`select id, slug, name from organizations where id = ${orgId} limit 1`);
  return !org || isAskExcluded(org, deps.config.askExclude ?? "");
}

/** Counts one rewrite against every cap before the call; gives it all back when any cap says no. */
async function reserveWrite(deps: Deps, orgId: string, units: number, day: string): Promise<boolean> {
  if (!(await reserveRow(deps, day, WRITE_ROW(orgId), 1, WRITE_DAILY))) return false;
  if (!(await reserveRow(deps, day, WRITE_GLOBAL_ROW, units, WRITE_GLOBAL_UNITS))) { await adjustRow(deps, day, WRITE_ROW(orgId), -1, true); return false; }
  if (await reserve(deps, orgId, await planOf(deps, orgId), units, day)) {
    await adjustRow(deps, day, WRITE_GLOBAL_ROW, -units, true); await adjustRow(deps, day, WRITE_ROW(orgId), -1, true);
    return false;
  }
  return true;
}

async function writesLeft(deps: Deps, orgId: string, day: string): Promise<number> {
  const [r] = await deps.db.all<{ units: number }>(sql`select units from ai_usage_daily where day = ${day} and org_id = ${WRITE_ROW(orgId)}`);
  return Math.max(0, WRITE_DAILY - (r?.units ?? 0));
}

async function rewrite(deps: Deps, orgId: string, action: WriteAction, text: string, max: number | null, day: string): Promise<string> {
  await assertAiAllowed(deps, orgId); // TD1: AI off means no provider call
  const runner = deps.askAi ?? deps.ai;
  if (!runner) throw new HttpError(503, "ai_unavailable", "Writing help isn't available right now.");
  const p = writePrompt(action, text, max);
  const est = unitsFor(CHAT_MODEL, estimateTokens(p.system) + estimateTokens(p.user) + 40, WRITE_MAX_TOKENS);
  if (!(await reserveWrite(deps, orgId, est, day))) throw new HttpError(429, "write_limit", WRITE_LIMIT_MESSAGE);
  try {
    const out = (await runner.run(CHAT_MODEL, { messages: [{ role: "system", content: p.system }, { role: "user", content: p.user }], max_tokens: WRITE_MAX_TOKENS, temperature: 0.4 })) as { response?: unknown };
    const raw = typeof out?.response === "string" ? out.response : "";
    if (!raw.trim()) throw new Error("empty");
    return cleanRewrite(raw, text, action, max);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    deps.log?.warn("social.write_help_failed", { action, error: err instanceof Error ? err.name : "error" });
    throw new HttpError(502, "write_failed", WRITE_ERROR_MESSAGE);
  }
}

/**
 * Writing help: shorter, friendlier, more formal, hashtags, or fit to each picked network's limit (one AI call for the
 * longest text over a limit, then cut at a word for the rest). Text in, text out: nothing is stored or logged.
 */
export async function writeHelp(deps: Deps, auth: AuthContext, input: { action: WriteAction; text: string; apps?: string[] }): Promise<WriteResult> {
  requireP3(deps);
  if (await excluded(deps, auth.orgId)) throw new HttpError(403, "write_off", "Writing help is not available in this workspace.");
  const text = (input.text ?? "").trim();
  if (!text) throw new HttpError(422, "empty", "Write something first.");
  if (text.length > WRITE_TEXT_MAX) throw new HttpError(422, "too_long", `Writing help takes up to ${WRITE_TEXT_MAX.toLocaleString("en-US")} characters.`);
  const day = deps.now().toISOString().slice(0, 10);
  const apps = [...new Set((input.apps ?? []).filter((a) => NETWORK_RULES[a]))];
  const limits = apps.map((a) => NETWORK_RULES[a]!.maxChars);
  const tightest = limits.length ? Math.min(...limits) : null;
  if (input.action !== "fit") {
    const out = await rewrite(deps, auth.orgId, input.action, text, null, day);
    return { text: out, left: await writesLeft(deps, auth.orgId, day) };
  }
  const over = apps.filter((a) => [...text].length > NETWORK_RULES[a]!.maxChars);
  if (!over.length) return { text, texts: {}, left: await writesLeft(deps, auth.orgId, day) };
  const short = await rewrite(deps, auth.orgId, "fit", text, tightest, day);
  const texts: Record<string, string> = {};
  for (const a of over) texts[a] = fitText(short, NETWORK_RULES[a]!.maxChars);
  return { text, texts, left: await writesLeft(deps, auth.orgId, day) };
}

/* ---------------------------------------------------------------- Snapchat share page */

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The small share page: the Snapchat share button for one https link, and nothing else. No session, no data. */
/** R132: the share page's only script, served from our own origin (no outside script, no page policy exception). */
export const SNAP_COPY_JS_PATH = "/share/snapchat-copy.js";
export const SNAP_COPY_JS = `(function(){var b=document.getElementById("copy-link"),i=document.getElementById("share-link"),s=document.getElementById("copy-status");if(!b||!i||!s)return;function done(ok){s.textContent=ok?"Link copied. Paste it in Snapchat.":"Couldn't copy. Select the link and copy it.";}b.addEventListener("click",function(){var v=b.getAttribute("data-link")||i.value;if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(v).then(function(){done(true)},function(){i.focus();i.select();var ok=false;try{ok=document.execCommand("copy")}catch(e){}done(ok)})}else{i.focus();i.select();var ok=false;try{ok=document.execCommand("copy")}catch(e){}done(ok)}});})();`;

/** R132: Snapchat's own web share address for a link. Works without the share script (the plain fallback on the share page). */
export function snapWebShareUrl(link: string): string {
  return `https://www.snapchat.com/scan?attachmentUrl=${encodeURIComponent(link)}`;
}

export function snapSharePage(link: string | undefined, _appId: string | null = null): { status: number; html: string } {
  const ok = !!link && isHttpsLink(link);
  const body = ok
    ? `<h1>Share to Snapchat</h1><p>Open Snapchat with this link attached, or copy the link and paste it there with your caption.</p>
<p class="actions"><a class="open" href="${esc(snapWebShareUrl(link!))}" rel="noopener noreferrer">Open in Snapchat</a>
<button type="button" class="copy" id="copy-link" data-link="${esc(link!)}">Copy link</button></p>
<label for="share-link" class="lbl">Link to share</label><input id="share-link" class="link" type="text" readonly value="${esc(link!)}">
<p id="copy-status" class="status" role="status" aria-live="polite"></p><script src="${SNAP_COPY_JS_PATH}"></script>`
    : `<h1>Nothing to share</h1><p>This share link is missing its web address. Go back to the composer and try again.</p>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Share to Snapchat</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:32px 20px;background:#fafafa;color:#1a1a1a;max-width:520px;margin:0 auto}h1{font-size:22px;margin:0 0 8px}p{margin:0 0 16px;color:#444}.link{word-break:break-all;font-size:14px;color:#555}.open{display:inline-flex;align-items:center;min-height:44px;padding:0 20px;border-radius:999px;background:#fffc00;color:#000;font-weight:600;text-decoration:none}.open:focus-visible,.copy:focus-visible,.link:focus-visible{outline:3px solid #1a73e8;outline-offset:2px}.actions{display:flex;flex-wrap:wrap;gap:12px}.copy{min-height:44px;padding:0 20px;border-radius:999px;border:1px solid #1a1a1a;background:#fff;color:#1a1a1a;font:inherit;font-weight:600;cursor:pointer}.lbl{display:block;font-size:14px;font-weight:600;margin:8px 0 4px}input.link{box-sizing:border-box;width:100%;min-height:44px;padding:8px 12px;border:1px solid #888;border-radius:8px;background:#fff;color:#1a1a1a;font:inherit;font-size:14px}.status{min-height:24px;margin-top:8px;font-size:14px}@media (prefers-color-scheme:dark){body{background:#141414;color:#eee}p{color:#bbb}.copy{background:#222;color:#eee;border-color:#bbb}input.link{background:#1e1e1e;color:#eee;border-color:#888}}</style>
</head><body><main>${body}</main></body></html>`;
  return { status: ok ? 200 : 400, html };
}
