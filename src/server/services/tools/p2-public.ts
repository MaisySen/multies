/**
 * Tools P2 (H5): the gates every share and sign route passes, and the bits public pages share
 * (same origin check plus a form token for public POSTs, the page shell and its styles).
 */
import type { Context } from "hono";
import type { AppEnv } from "../../context";
import { HttpError, notFound } from "../../lib/errors";
import { hmacSha256Hex, safeEqual } from "../../lib/crypto";
import { readToolState, toolsOnFor } from "./usage";
import { requireToolFeature, toolFeatureOn } from "./features";
import type { ToolFeature } from "@/shared/tool-features";

/** Signed in routes: Tools on for the deployment, the feature flag on, the workspace switch on. */
export async function gateP2(c: Context<AppEnv>, f: ToolFeature): Promise<void> {
  requireToolFeature(c, f);
  const s = await readToolState(c.var.deps.db, c.var.auth.orgId, c.var.deps.now());
  if (!s || !toolsOnFor(s)) throw notFound("Page");
}

/** Public pages answer 404 while the feature is off. */
export const publicOn = (c: Context<AppEnv>, f: ToolFeature) => toolFeatureOn(c, f);

/** A form token bound to one public token: a page from another site cannot know it. */
export async function formToken(c: Context<AppEnv>, scope: string, tokenHash: string): Promise<string> {
  return (await hmacSha256Hex(c.var.deps.config.appSecret, `p2form:${scope}:${tokenHash}`)).slice(0, 40);
}

/**
 * Public POSTs: the browser's own origin signals must not name another site (Origin or Sec-Fetch-Site), and
 * the form token must match. Returns false instead of throwing so pages can answer with HTML.
 */
export async function publicPostOk(c: Context<AppEnv>, scope: string, tokenHash: string, presented: string | null | undefined): Promise<boolean> {
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = c.req.header("origin");
  if (origin && origin !== "null") {
    let own = "";
    try { own = new URL(c.var.deps.config.appUrl).origin; } catch { /* no app URL */ }
    const reqOrigin = new URL(c.req.url).origin;
    if (origin !== own && origin !== reqOrigin) return false;
  } else if (origin === "null" && site !== "same-origin") return false; // a no-referrer page sends Origin: null; Sec-Fetch-Site still says same-origin
  if (!presented) return false;
  return safeEqual(await formToken(c, scope, tokenHash), presented);
}

export const PUBLIC_HEADERS = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "same-origin" } as const;

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function sizeText(n: number) {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** A plain page with no app chrome: no menus, no sign in, nothing from the workspace but what the page names. */
export function publicPage(title: string, body: string, opts: { script?: string } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><title>${esc(title)} | Multies</title><style>${PUBLIC_CSS}</style></head><body>${body}${opts.script ? `<script src="${esc(opts.script)}" defer></script>` : ""}</body></html>`;
}

export function attachmentDisposition(name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function httpErrorPage(e: unknown) {
  if (e instanceof HttpError) return e;
  return null;
}

const PUBLIC_CSS = `
:root{color-scheme:light dark;--bg:#f5f5f7;--fg:#1d1d1f;--muted:#6e6e73;--line:#d2d2d7;--card:#fff;--brand:#0071E3;--bad:#d70015;--good:#248a3d}
@media (prefers-color-scheme:dark){:root{--bg:#000;--fg:#f5f5f7;--muted:#a1a1a6;--line:#38383a;--card:#1c1c1e;--bad:#ff453a;--good:#30d158}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
.top{display:flex;align-items:center;gap:12px;padding:14px 24px;border-bottom:1px solid var(--line)}.brand{font-weight:600;color:var(--fg);letter-spacing:-.01em}.ws{color:var(--muted);font-size:13px}
main{max-width:560px;margin:8vh auto;padding:0 20px 60px}main.wide{max-width:760px;margin-top:4vh}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px}
h1{font-size:22px;line-height:1.25;letter-spacing:-.02em;margin:0 0 6px;word-break:break-word}h2{font-size:16px;margin:22px 0 8px}
p{margin:.5em 0}.muted{color:var(--muted)}.small{font-size:13px}.err{color:var(--bad)}.ok{color:var(--good)}
.file{display:flex;gap:14px;align-items:center;margin:4px 0 18px}.ico{flex:none;width:44px;height:52px;border-radius:8px;background:color-mix(in srgb,var(--brand) 12%,transparent);color:var(--brand);display:grid;place-items:center;font-weight:600;font-size:12px}
label{display:block;font-size:13px;font-weight:500;margin:12px 0 6px}input[type=password],input[type=text],input[type=email],textarea,select{width:100%;font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
textarea{min-height:80px}button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;font:inherit;font-weight:600;border:0;border-radius:10px;padding:11px 18px;background:var(--brand);color:#fff;cursor:pointer;text-decoration:none;min-height:44px}
button.sec,.btn.sec{background:transparent;color:var(--fg);border:1px solid var(--line)}button.bad{background:transparent;color:var(--bad);border:1px solid var(--line)}button[disabled]{opacity:.5;cursor:default}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:16px}.full{width:100%}
.tabs{display:flex;gap:6px;margin:8px 0}.tabs button{background:transparent;color:var(--fg);border:1px solid var(--line);padding:6px 12px;min-height:36px;font-weight:500}.tabs button[aria-selected=true]{border-color:var(--brand);color:var(--brand)}
canvas.pad{width:100%;height:160px;border:1px dashed var(--line);border-radius:12px;background:#fff;touch-action:none;display:block}
.typed{font-size:40px;padding:10px 6px;border:1px solid var(--line);border-radius:12px;background:#fff;color:#111;cursor:pointer;margin:6px 0;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.typed[aria-checked=true]{outline:2px solid var(--brand)}
.check{display:flex;gap:10px;align-items:flex-start;margin:14px 0;font-size:14px}.check input{margin-top:4px}
.note{font-size:13px;color:var(--muted);border-top:1px solid var(--line);margin-top:22px;padding-top:14px}
.pages{display:flex;gap:12px;flex-wrap:wrap;margin:10px 0}.pg{position:relative;border:1px solid var(--line);border-radius:6px;overflow:hidden;background:#fff}.pg img{display:block;max-width:100%}.pg .box{position:absolute;border:2px solid var(--brand);background:color-mix(in srgb,var(--brand) 18%,transparent);border-radius:3px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
.hidden{display:none}
`;
