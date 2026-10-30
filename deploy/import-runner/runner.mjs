// MyMail import runner: copies mail from Gmail, Outlook or any IMAP server into MyMail.
//
// It asks MyMail for a queued import, reads the old mailbox over IMAP (imapflow) with the
// app password the customer gave, and posts each message to MyMail, which stores it once
// (duplicates by Message-ID are skipped). Run it anywhere with outbound internet:
//
//   MYMAIL_URL=https://mymail.example IMPORT_RUNNER_TOKEN=... node runner.mjs
//
// or with Docker (see README.md). One job at a time; start more containers for more.
import { ImapFlow } from "imapflow";

const BASE = (process.env.MYMAIL_URL ?? "").replace(/\/$/, "");
const TOKEN = process.env.IMPORT_RUNNER_TOKEN ?? "";
const IDLE_MS = Number(process.env.POLL_SECONDS ?? 15) * 1000;
if (!BASE || !TOKEN) { console.error("Set MYMAIL_URL and IMPORT_RUNNER_TOKEN."); process.exit(1); }

const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}/api/import-runner${path}`, { ...init, method: "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
  if (res.status >= 400 && res.status !== 409) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res;
};
const json = (body) => ({ body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const log = (msg, extra = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...extra }));

async function run(job) {
  const client = new ImapFlow({ host: job.source.host, port: job.source.port, secure: true, auth: { user: job.source.user, pass: job.source.password }, logger: false });
  await client.connect();
  try {
    const all = await client.list();
    const wanted = all.filter((f) => !f.flags.has("\\Noselect")).filter((f) => job.folders.include.length
      ? job.folders.include.includes(f.path) || job.folders.include.some((name) => f.specialUse && name.endsWith(f.name))
      : !job.folders.skip.some((s) => f.path.toLowerCase() === s.toLowerCase() || f.name.toLowerCase() === s.toLowerCase()));
    let total = 0;
    for (const f of wanted) total += (await client.status(f.path, { messages: true })).messages ?? 0;
    await api(`/jobs/${job.id}/progress`, json({ total }));
    log("import.started", { job: job.id, folders: wanted.map((f) => f.path), total });
    for (const f of wanted) {
      const lock = await client.getMailboxLock(f.path);
      try {
        if (!client.mailbox.exists) continue;
        for await (const msg of client.fetch("1:*", { source: true, flags: true })) {
          const res = await api(`/jobs/${job.id}/messages`, { body: msg.source, headers: { "content-type": "message/rfc822", "x-mymail-folder": f.path, "x-mymail-seen": String(msg.flags?.has("\\Seen") ?? true) } });
          if (res.status === 409) { log("import.stopped", { job: job.id, reason: await res.text() }); return; }
        }
      } finally { lock.release(); }
    }
    await api(`/jobs/${job.id}/finish`, json({}));
    log("import.finished", { job: job.id });
  } finally {
    await client.logout().catch(() => {});
  }
}

for (;;) {
  try {
    const res = await api("/claim");
    if (res.status === 204) { await new Promise((r) => setTimeout(r, IDLE_MS)); continue; }
    const { job } = await res.json();
    try { await run(job); } catch (err) {
      const reason = /auth|login|credentials/i.test(String(err?.responseText ?? err?.message)) ? "The old mailbox refused the sign in. Check the address and app password." : String(err?.message ?? err).slice(0, 300);
      log("import.failed", { job: job.id, error: String(err?.message ?? err) });
      await api(`/jobs/${job.id}/finish`, json({ error: reason })).catch(() => {});
    }
  } catch (err) {
    log("runner.error", { error: String(err?.message ?? err) });
    await new Promise((r) => setTimeout(r, IDLE_MS));
  }
}
