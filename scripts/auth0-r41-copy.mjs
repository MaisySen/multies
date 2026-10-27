#!/usr/bin/env node
/**
 * R41 (MB-223, MB-233): puts the sign in pages and the confirmation and reset emails in the Multies voice,
 * from deploy/auth0/r41-copy.json, on the identity provider tenant. Dry run by default: prints what would
 * change (names and lengths only). The R41 lead applies it once:
 *
 *   node scripts/auth0-r41-copy.mjs            # dry run
 *   node scripts/auth0-r41-copy.mjs --apply    # write prompts text, the login URI and the two templates
 *
 * Secrets come from ~/.multies-secrets/auth0-multies.json (the tenant management client), as in
 * scripts/auth-mail-check.mjs; nothing secret is printed or passed on a command line. The app's web client
 * id is read from AUTH0_CLIENT_ID in the environment or that file's web_client_id.
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** "join your team.The link" -> "join your team. The link", also across inline tags; pure for tests. */
export function fixSentenceSpacing(html) {
  return String(html).replace(/([a-z0-9)])\.((?:<[^>]+>)*)(?=[A-Z])/g, (_m, a, tags) => (tags && /<\/?(p|br|div|h\d|tr|td|li)\b/i.test(tags) ? `${a}.${tags}` : `${a}. ${tags ?? ""}`));
}

/**
 * R45 (MB-233): the plain text part of the mail is made from the HTML by joining text with nothing between table rows
 * or after a line break, so "join your team." and "The link" in two rows became "team.The link", and "browser:" ran into
 * the link. A line break in the source after each row and each <br> gives the text part its line breaks. Pure for tests.
 */
export function fixTextBreaks(html) {
  return String(html).replace(/<\/tr>(?=\s*<tr)(?!\s)/gi, "</tr>\r\n").replace(/(<br\s*\/?>)(?![\r\n])/gi, "$1\r\n");
}

/** Copy rules the hosted page text must meet: no exclamation marks, no dashes, no Title Case Headings. */
export function copyProblems(copy) {
  const out = [];
  const walk = (o, at) => {
    for (const [k, v] of Object.entries(o)) {
      if (k.startsWith("_")) continue;
      if (v && typeof v === "object") walk(v, `${at}.${k}`);
      else if (typeof v === "string") {
        if (v.includes("!")) out.push(`${at}.${k}: exclamation mark`);
        if (/[\u2013\u2014]/.test(v)) out.push(`${at}.${k}: dash`);
        if (/title$/i.test(k) && /^[A-Z][a-z]+ [A-Z][a-z]+/.test(v) && !/Multies/.test(v.split(" ")[1])) out.push(`${at}.${k}: Title Case`);
      }
    }
  };
  walk(copy.prompts ?? {}, "prompts");
  return out;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const copy = JSON.parse(readFileSync(path.join(here, "..", "deploy", "auth0", "r41-copy.json"), "utf8"));
  const problems = copyProblems(copy);
  if (problems.length) { console.error("copy problems:\n" + problems.join("\n")); process.exit(1); }
  const s = JSON.parse(readFileSync(process.env.AUTH0_MULTIES_SECRETS || path.join(os.homedir(), ".multies-secrets", "auth0-multies.json"), "utf8"));
  const domain = s.domain;
  const tr = await fetch(`https://${domain}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", client_id: s.tab_mgmt_client_id, client_secret: s.tab_mgmt_client_secret, audience: `https://${domain}/api/v2/` }),
  });
  if (!tr.ok) throw new Error(`identity provider token ${tr.status}`);
  const tok = (await tr.json()).access_token;
  const api = async (method, p, body) => {
    const r = await fetch(`https://${domain}/api/v2${p}`, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${p.split("?")[0]} ${r.status}: ${text.slice(0, 300)}`); // the provider error text names the bad key; it carries no secret
    return text ? JSON.parse(text) : null;
  };
  for (const [prompt, byLang] of Object.entries(copy.prompts)) {
    for (const [lang, screens] of Object.entries(byLang)) {
      console.log(`${apply ? "set" : "would set"} prompt ${prompt}/${lang}: ${Object.keys(screens).join(", ")}`);
      if (apply) await api("PUT", `/prompts/${prompt}/custom-text/${lang}`, screens);
    }
  }
  let clientId = process.env.AUTH0_CLIENT_ID || s.web_client_id;
  if (!clientId) {
    // The web client id is not a secret: find the one regular web app (ids and names only).
    const webs = ((await api("GET", "/clients?fields=client_id,name,app_type&include_fields=true")) ?? []).filter((c) => c.app_type === "regular_web");
    const prod = webs.length === 1 ? webs[0] : webs.find((c) => c.name === "Multies"); // the production app; staging keeps its own
    if (prod) clientId = prod.client_id;
    else console.log(`web clients found: ${webs.map((c) => c.name).join(", ") || "none"}`);
  }
  if (clientId) {
    console.log(`${apply ? "set" : "would set"} the web client's login URI to ${copy.client.initiate_login_uri}`);
    if (apply) await api("PATCH", `/clients/${clientId}`, { initiate_login_uri: copy.client.initiate_login_uri });
  } else console.log("skip login URI: no web client id (AUTH0_CLIENT_ID or web_client_id)");
  for (const name of copy.email_templates.names) {
    const t = await api("GET", `/email-templates/${name}`);
    const body = fixTextBreaks(fixSentenceSpacing(t.body ?? ""));
    const changed = body !== t.body;
    console.log(`${name}: ${changed ? `${apply ? "fixed" : "would fix"} sentence spacing or text line breaks` : "spacing already fine"}`);
    if (apply && changed) await api("PATCH", `/email-templates/${name}`, { body });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => { console.error(String(err.message ?? err)); process.exit(1); });
}
