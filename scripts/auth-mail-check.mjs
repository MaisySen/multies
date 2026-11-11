#!/usr/bin/env node
/**
 * Sign in mail check (27 Oct 2026). On production, confirmation and password reset emails are sent by
 * the identity provider (Auth0 tenant multies.au), through its SMTP email provider (smtp.resend.com).
 * On 26 Oct the Resend key in that SMTP setting was revoked in a key rotation and every confirmation
 * and reset email failed with "535 Authentication credentials invalid" for a day, while the app
 * itself looked healthy. Auth0 now has its own send only key ("Multies Auth0 sign-in mail").
 *
 *   node scripts/creds.mjs run RESEND_API_KEY -- node scripts/auth-mail-check.mjs [--probe] [--minutes 60]
 *
 * Without --probe it is read only: the email provider is on, and the tenant logged no failed email
 * ("fn") in the last --minutes. With --probe it also creates a throwaway user at a plus address of our
 * own test inbox (auth-mail-probe.json beside the secrets file) with verify_email on, waits (up to --probe-seconds, 180 by
 * default) until Resend reports that confirmation email delivered, bounced or failed (or
 * Auth0 logs a failure), then deletes the user. Secrets come from ~/.multies-secrets/auth0-multies.json
 * (the tenant management client) and RESEND_API_KEY in the environment; nothing secret is printed.
 */
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Resend events that mean the provider took the message and sent it on. */
const ACCEPTED = new Set(["sent", "delivered", "delivery_delayed", "opened", "clicked"]);
/** Events after which nothing more will happen to the message: stop waiting. */
const FINAL = new Set(["delivered", "opened", "clicked", "bounced", "complained", "failed", "canceled"]);

/**
 * R44: what the probe loop does after reading the email's last event. "queued" and "scheduled" (and no
 * email yet) mean it has not left the provider: keep waiting (R43b gave up at "queued" after 60 s and the
 * smoke failed while the mail went out a little later). "sent" and "delivery_delayed" have left: keep
 * waiting for the delivery report, but they count as sent if the time runs out. A final event stops at once.
 * Pure so it can be unit tested.
 */
export function probeStep(event, elapsedMs, budgetMs) {
  if (event && FINAL.has(event)) return "stop";
  return elapsedMs >= budgetMs ? "stop" : "wait";
}

/**
 * The verdict, pure so it can be unit tested.
 * provider: Auth0's email provider answer; failures: fn log entries in the window;
 * probe: undefined (not run), or { event } with the Resend last_event, or { authFailure } when Auth0 logged one.
 */
export function judge({ provider, failures = [], probe }) {
  const problems = [];
  if (!provider || provider.enabled !== true) problems.push("the identity provider's email provider is off or missing");
  for (const f of failures) problems.push(`failed email to ${f.to ?? "someone"} at ${f.date}: ${f.error ?? "no detail"}`);
  if (probe) {
    if (probe.authFailure) problems.push(`probe email failed at the identity provider: ${probe.authFailure}`);
    else if (!probe.event) problems.push("probe email never reached the email provider");
    else if (!ACCEPTED.has(probe.event)) problems.push(`probe email was not accepted (${probe.event})`);
  }
  return { ok: problems.length === 0, problems };
}

/** Start of the failure window: the last --minutes, or the last email provider change if that is later. */
export function windowStart(nowMs, minutes, providerChangedAt) {
  const base = nowMs - minutes * 60_000;
  const changed = providerChangedAt ? Date.parse(providerChangedAt) : NaN;
  return new Date(Number.isFinite(changed) && changed > base ? changed : base).toISOString();
}

function failuresFrom(logs) {
  return (logs ?? []).filter((l) => l.type === "fn").map((l) => ({ date: l.date, to: l.details?.to, error: l.details?.error }));
}

async function main() {
  const args = process.argv.slice(2);
  const probeOn = args.includes("--probe");
  const mi = args.indexOf("--minutes");
  const minutes = mi >= 0 ? Number(args[mi + 1]) || 60 : 60;
  const secretsPath = process.env.AUTH0_MULTIES_SECRETS || path.join(os.homedir(), ".multies-secrets", "auth0-multies.json");
  // Semgrep (QUAL1): reads the private secrets file (AUTH0_MULTIES_SECRETS or ~/.multies-secrets); no value in the repo.
  const s = JSON.parse(readFileSync(secretsPath, "utf8")); // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret
  const domain = s.domain;
  const tr = await fetch(`https://${domain}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", client_id: s.tab_mgmt_client_id, client_secret: process.env.AUTH0_TAB_MGMT_CLIENT_SECRET || s.tab_mgmt_client_secret, audience: `https://${domain}/api/v2/` }),
  });
  // POL3: the creds store is the record every rotation updates; the JSON file above went stale after the Nov 2
  // rotation and smoke read 401. smoke.sh passes AUTH0_TAB_MGMT_CLIENT_SECRET from the store; the file is the fallback.
  if (!tr.ok) throw new Error(`identity provider token ${tr.status}${tr.status === 401 ? " (management client secret is stale: run through creds.mjs with AUTH0_TAB_MGMT_CLIENT_SECRET, or refresh the secrets file after a rotation)" : ""}`);
  const tok = (await tr.json()).access_token;
  const api = async (method, p, body) => {
    const r = await fetch(`https://${domain}/api/v2${p}`, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    if (!r.ok && r.status !== 404) throw new Error(`${method} ${p.split("?")[0]} ${r.status}`);
    return text ? JSON.parse(text) : null;
  };
  const provider = await api("GET", "/emails/provider?fields=name,enabled,default_from_address&include_fields=true");
  // Failures from before the provider setting last changed were fixed by that change, so they don't count.
  const changed = await api("GET", `/logs?q=${encodeURIComponent('type:sapi AND description:"Update email provider"')}&per_page=1&sort=date:-1`);
  const since = windowStart(Date.now(), minutes, changed?.[0]?.date);
  const recent = await api("GET", `/logs?q=${encodeURIComponent(`type:fn AND date:[${since} TO *]`)}&per_page=20&sort=date:-1`);
  const failures = failuresFrom(recent);

  let probe;
  if (probeOn) {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error("--probe needs RESEND_API_KEY in the environment (scripts/creds.mjs run RESEND_API_KEY -- ...)");
    // Our own test inbox (plus addresses reach it). Kept out of the repo: ~/.multies-secrets/auth-mail-probe.json {"inbox": "..."}.
    // Semgrep (QUAL1): a file name in the private secrets folder, not a value.
    const probeFile = path.join(path.dirname(secretsPath), "auth-mail-probe.json"); // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret
    const inbox = process.env.AUTH_MAIL_PROBE_INBOX || JSON.parse(readFileSync(probeFile, "utf8")).inbox;
    const [local, host] = inbox.split("@");
    const email = `${local}+mailcheck${randomBytes(3).toString("hex")}@${host}`;
    const started = Date.now();
    const user = await api("POST", "/users", { connection: "Username-Password-Authentication", email, password: `${randomBytes(18).toString("base64url")}aA1!`, verify_email: true, name: "Mail check" });
    try {
      probe = {};
      // R44: wait up to --probe-seconds (180 by default) for the email to leave the provider and be delivered.
      const pi = args.indexOf("--probe-seconds");
      const budgetMs = (pi >= 0 ? Number(args[pi + 1]) || 180 : 180) * 1000;
      let emailId;
      for (let i = 0; ; i++) {
        await new Promise((r) => setTimeout(r, i < 10 ? 3000 : 6000));
        const fl = await api("GET", `/users/${encodeURIComponent(user.user_id)}/logs?per_page=10&sort=date:-1`);
        const fn = (fl ?? []).find((l) => l.type === "fn");
        if (fn) { probe.authFailure = fn.details?.error ?? "failed"; break; }
        if (!emailId) {
          const rr = await fetch("https://api.resend.com/emails?limit=50", { headers: { authorization: `Bearer ${key}` } });
          if (rr.ok) emailId = ((await rr.json()).data ?? []).find((e) => (e.to ?? []).includes(email))?.id;
        }
        if (emailId) {
          // Read this one email by id: the list can push it out when other mail goes at the same time.
          const er = await fetch(`https://api.resend.com/emails/${encodeURIComponent(emailId)}`, { headers: { authorization: `Bearer ${key}` } });
          if (er.ok) {
            const e = await er.json();
            if (e.last_event) { probe.event = e.last_event; probe.seconds = Math.round((Date.now() - started) / 1000); }
          }
        }
        if (probeStep(probe.event, Date.now() - started, budgetMs) === "stop") break;
      }
    } finally {
      await api("DELETE", `/users/${encodeURIComponent(user.user_id)}`).catch(() => undefined);
    }
  }

  const v = judge({ provider, failures, probe });
  if (v.ok) {
    console.log(`sign in mail: ok (provider ${provider.name}, no failed email in ${minutes} min${probe ? `, probe ${probe.event} in ${probe.seconds} s` : ""})`);
  } else {
    for (const p of v.problems) console.error(`sign in mail: ${p}`);
    console.error("See docs/runbooks/auth-mail.md");
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`sign in mail check could not run: ${err.message}`); process.exit(2); });
}
