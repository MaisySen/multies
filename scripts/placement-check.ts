/**
 * R34 (MB-170, reviewer 4.4): inbox placement check. Sends ONE test mail from multies.si to seed mailboxes you
 * own (Gmail, Outlook, Yahoo, iCloud, ...), then reads where it landed (Inbox, Spam/Junk, Promotions) over each
 * seed's IMAP when its login is configured, else prints the manual check list.
 *
 * Nothing secret lives in the repo. Everything comes from the environment (or a JSON file outside the repo):
 *   PLACEMENT_SEEDS        comma list of seed addresses, each optionally labelled: "gmail=me+seed@gmail.com,outlook=x@outlook.com"
 *   PLACEMENT_SEEDS_FILE   instead, a JSON file: [{ "label", "address", "imap": { "host", "port", "user", "pass" } }]
 *   PLACEMENT_IMAP_<LABEL> per seed IMAP login as "host:port:user:pass" (an app password, never the real one)
 *   PLACEMENT_FROM         sender, default "Multies deliverability <check@multies.si>"
 *   RESEND_API_KEY         the outbound provider key (the same one production uses)
 *
 * Usage:
 *   npx tsx scripts/placement-check.ts                 dry run: shows what would be sent and to whom, sends nothing
 *   npx tsx scripts/placement-check.ts --send          sends the one test mail, waits, then checks each seed
 *   npx tsx scripts/placement-check.ts --check <token> only checks the seeds for an earlier send
 * Options: --wait <seconds> (default 90) before reading IMAP.
 * Runbook: docs/runbooks/live-mail.md, "Inbox placement check".
 */
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

export interface ImapLogin { host: string; port: number; user: string; pass: string }
export interface Seed { label: string; address: string; imap?: ImapLogin }
export type Placement = "inbox" | "spam" | "promotions" | "other" | "missing";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Pure: "host:port:user:pass" (the password may itself hold colons). */
export function parseImap(v: string | undefined): ImapLogin | undefined {
  if (!v) return undefined;
  const [host, port, user, ...rest] = v.split(":");
  const pass = rest.join(":");
  if (!host || !port || !user || !pass || !/^\d+$/.test(port)) throw new Error("An IMAP login must look like host:port:user:pass.");
  return { host, port: Number(port), user, pass };
}

/** Pure: a label from the address's provider ("gmail" for x@gmail.com). */
export function labelFor(address: string) {
  const domain = address.split("@")[1]?.toLowerCase() ?? "";
  return domain.replace(/\.(com|net|org|co|io|me)(\.[a-z]{2})?$/, "").replace(/[^a-z0-9]+/g, "_") || "seed";
}

/** Pure: the seed list from the environment. Throws a plain error on a bad address. */
export function parseSeeds(env: Record<string, string | undefined>, readFile: (p: string) => string = (p) => readFileSync(p, "utf8")): Seed[] {
  let seeds: Seed[];
  if (env.PLACEMENT_SEEDS_FILE) {
    const raw = JSON.parse(readFile(env.PLACEMENT_SEEDS_FILE)) as Seed[];
    if (!Array.isArray(raw)) throw new Error("PLACEMENT_SEEDS_FILE must hold a JSON list of seeds.");
    seeds = raw.map((s) => ({ label: s.label || labelFor(s.address), address: s.address, imap: s.imap }));
  } else {
    seeds = (env.PLACEMENT_SEEDS ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((entry) => {
      const [maybeLabel, maybeAddr] = entry.includes("=") ? entry.split("=", 2) : [undefined, entry];
      const address = (maybeAddr ?? "").trim();
      return { label: (maybeLabel?.trim() || labelFor(address)).toLowerCase(), address };
    });
  }
  for (const s of seeds) {
    if (!EMAIL.test(s.address)) throw new Error(`"${s.address}" is not an email address.`);
    s.imap ??= parseImap(env[`PLACEMENT_IMAP_${s.label.toUpperCase()}`]);
  }
  const labels = new Set<string>();
  for (const s of seeds) { if (labels.has(s.label)) throw new Error(`Two seeds share the label "${s.label}". Label them, like gmail2=...`); labels.add(s.label); }
  return seeds;
}

/** Pure: a short token that goes in the subject and a header, so the check finds exactly this send. */
export function makeToken(rand: () => Buffer = () => randomBytes(5)) { return `MPC-${rand().toString("hex")}`; }

/** Pure: the test mail. Plain and HTML parts, a real unsubscribe header, nothing that looks like bulk mail. */
export function buildMessage(from: string, to: string[], token: string, now = new Date()) {
  const date = now.toISOString().slice(0, 16).replace("T", " ");
  return {
    from, to,
    subject: `Multies placement check ${token}`,
    text: `Hello,\n\nThis is a one-off delivery check from Multies, sent ${date} UTC. You can ignore it.\n\nReference: ${token}\n\nThe Multies team\nhttps://multies.si`,
    html: `<p>Hello,</p><p>This is a one-off delivery check from Multies, sent ${date} UTC. You can ignore it.</p><p>Reference: ${token}</p><p>The Multies team<br><a href="https://multies.si">multies.si</a></p>`,
    headers: { "X-Multies-Placement": token, "List-Unsubscribe": "<mailto:unsubscribe@multies.si>" },
  };
}

/** Pure: which placement an IMAP folder means, from its special-use flag first, then its name. */
export function classifyFolder(path: string, specialUse?: string): Placement {
  const su = (specialUse ?? "").toLowerCase();
  if (su === "\\junk") return "spam";
  if (su === "\\inbox" || path.toUpperCase() === "INBOX") return "inbox";
  const p = path.toLowerCase();
  if (/(spam|junk|bulk)/.test(p)) return "spam";
  if (/(promotion|categor|social|updates|forums)/.test(p)) return "promotions";
  return "other";
}

/** Pure: Gmail files Promotions as a label on an INBOX message; the X-GM-LABELS of the hit say so. */
export function refineGmail(placement: Placement, labels: string[] | undefined): Placement {
  if (placement !== "inbox" || !labels?.length) return placement;
  return labels.some((l) => /promotions|social|updates|forums/i.test(l)) ? "promotions" : "inbox";
}

/** Pure: the one-screen report, and the exit code (0 all inbox, 1 anything else). */
export function report(results: { seed: Seed; placement: Placement | "manual"; folder?: string }[]) {
  const lines = results.map((r) => `${r.seed.label.padEnd(10)} ${r.seed.address.padEnd(34)} ${r.placement === "manual" ? "check by hand" : r.placement}${r.folder ? ` (${r.folder})` : ""}`);
  const checked = results.filter((r) => r.placement !== "manual");
  const inbox = checked.filter((r) => r.placement === "inbox").length;
  const summary = checked.length ? `${inbox} of ${checked.length} checked seeds in the inbox.` : "No seed has IMAP configured, so nothing was checked automatically.";
  return { text: [...lines, "", summary].join("\n"), code: checked.every((r) => r.placement === "inbox") ? 0 : 1 };
}

/** Pure: what to do by hand for seeds without IMAP. */
export function manualChecklist(seeds: Seed[], token: string) {
  if (!seeds.length) return "";
  return [
    `Manual check: in each mailbox below, search for "${token}" and note where it is.`,
    ...seeds.map((s) => `  [ ] ${s.label}: ${s.address}. Inbox, Promotions/Other tab, or Spam/Junk?`),
    "  For each hit, open the message, show the original (Gmail: Show original; Outlook: View source) and check",
    "  that SPF, DKIM and DMARC all say pass and that DKIM d= is multies.si.",
    "  Note the results in docs/runbooks/live-mail.md under Inbox placement check, with the date.",
  ].join("\n");
}

async function send(apiKey: string, msg: ReturnType<typeof buildMessage>) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(msg), signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`The outbound provider refused the send (${r.status}): ${(await r.text()).slice(0, 300)}`);
  return (await r.json()) as { id: string };
}

async function find(seed: Seed & { imap: ImapLogin }, token: string): Promise<{ placement: Placement; folder?: string }> {
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({ host: seed.imap.host, port: seed.imap.port, secure: seed.imap.port === 993, auth: { user: seed.imap.user, pass: seed.imap.pass }, logger: false });
  await client.connect();
  try {
    const boxes = await client.list();
    // Inbox first, then spam, then the rest; stop at the first hit.
    const order = [...boxes].sort((a, b) => rank(classifyFolder(a.path, a.specialUse)) - rank(classifyFolder(b.path, b.specialUse)));
    for (const box of order) {
      if (box.flags?.has("\\Noselect")) continue;
      const lock = await client.getMailboxLock(box.path);
      try {
        const uids = await client.search({ subject: token }, { uid: true });
        if (uids && uids.length) {
          let labels: string[] | undefined;
          try { for await (const m of client.fetch(uids.slice(-1), { labels: true }, { uid: true })) labels = m.labels ? [...m.labels] : undefined; } catch { /* not Gmail */ }
          return { placement: refineGmail(classifyFolder(box.path, box.specialUse), labels), folder: box.path };
        }
      } finally { lock.release(); }
    }
    return { placement: "missing" };
  } finally { await client.logout().catch(() => undefined); }
}
const rank = (p: Placement) => ({ inbox: 0, promotions: 1, spam: 2, other: 3, missing: 4 })[p];

async function main(argv: string[]) {
  const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const seeds = parseSeeds(process.env);
  if (!seeds.length) { console.log("No seeds. Set PLACEMENT_SEEDS (or PLACEMENT_SEEDS_FILE); see docs/runbooks/live-mail.md."); return 2; }
  const from = process.env.PLACEMENT_FROM ?? "Multies deliverability <check@multies.si>";
  let token = arg("--check");
  if (!token) {
    token = makeToken();
    const msg = buildMessage(from, seeds.map((s) => s.address), token);
    if (!argv.includes("--send")) {
      console.log(`Dry run: would send "${msg.subject}" from ${from} to ${seeds.length} seeds:\n${seeds.map((s) => `  ${s.label}: ${s.address}${s.imap ? " (IMAP check)" : " (check by hand)"}`).join("\n")}\nAdd --send to send it.`);
      return 0;
    }
    const key = process.env.RESEND_API_KEY;
    if (!key) { console.log("RESEND_API_KEY is not set, so nothing was sent."); return 2; }
    const { id } = await send(key, msg);
    console.log(`Sent ${token} (provider id ${id}) to ${seeds.length} seeds.`);
    const wait = Number(arg("--wait") ?? 90);
    if (seeds.some((s) => s.imap)) { console.log(`Waiting ${wait} s before reading the seeds...`); await new Promise((r) => setTimeout(r, wait * 1000)); }
  }
  const results: { seed: Seed; placement: Placement | "manual"; folder?: string }[] = [];
  for (const seed of seeds) {
    if (!seed.imap) { results.push({ seed, placement: "manual" }); continue; }
    try { results.push({ seed, ...(await find(seed as Seed & { imap: ImapLogin }, token)) }); }
    catch (err) { console.log(`${seed.label}: IMAP read failed (${(err as Error).message}); check by hand.`); results.push({ seed, placement: "manual" }); }
  }
  const r = report(results);
  console.log(r.text);
  const manual = manualChecklist(results.filter((x) => x.placement === "manual").map((x) => x.seed), token);
  if (manual) console.log(`\n${manual}`);
  return r.code;
}

if (process.argv[1] && /placement-check\.ts$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error((err as Error).message); process.exit(2); });
}
