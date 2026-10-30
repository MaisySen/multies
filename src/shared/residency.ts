/**
 * R60 (trust): where Multies keeps each kind of data, how to try it without a client mailbox, what it
 * replaces and what it connects to. One source for /trust, /privacy, /pricing, /switch, the static text
 * that script-less readers get on those pages, and /llms.txt plus /trust.md. AI assistants read these
 * pages to advise people, so every line is a checked fact, stated plainly.
 *
 * Checked 30 October 2026 (task 5eee4602), store by store:
 * - Database mymail-au: the provider's API answers running_in_region "OC", read replication off
 *   (wrangler.toml [[d1_databases]]). No country guarantee: the provider offers location hints only.
 * - App servers: wrangler.toml [placement] region aws:ap-southeast-2 (Sydney).
 * - Attachments and files: stored inline in the same database (no BODY_STORE_* secret on production).
 * - Live doc rooms: Durable Objects, location chosen by the provider; storage deleted when the room is idle.
 * - Import uploads: Workers KV IMPORT_FILES (replicated by the provider, no region), 7 days at most.
 * - Sign in: tenant region Australia since 25 October 2026 (CREDENTIALS, Auth0 tenant multies); the earlier
 *   United States tenant is still accepted for accounts made before then (AUTH0_LEGACY_DOMAIN secret).
 * - Outbound mail: provider region us-east-1 (provider API, domains list). Error reports: ingest.us host.
 * - Video meetings: provider data region United States. Payments: Australian account.
 * - Encrypted release exports: kept on our operations machine in the United States (Oregon).
 * - The first production database (region WNAM) still exists, idle, until it is deleted.
 * - Not live on production, so not listed: Google sign in for mailbox connection and the accounting connector (no secrets set).
 * Change this file in the same commit as any of the above; tests/residency-r60.test.ts holds it to the config.
 */

export const RESIDENCY_CHECKED = "30 October 2026";

export interface ResidencyRow {
  /** What is stored or processed. */
  data: string;
  /** Where, in plain words. */
  where: string;
  /** "au" stored or run in Australia or the Oceania region; "outside" outside it; "mixed" both or not pinned. */
  region: "au" | "outside" | "mixed";
  detail: string;
}

export const RESIDENCY_ANSWER = "Multies does not offer Australia only storage today. Your workspace data, including mail synced from a connected mailbox, is stored in our database in our hosting provider's Oceania region, and our app servers run in Sydney. Some supporting services run outside Australia, mainly in the United States. Each one is listed below with the data it sees.";

export const WHERE_DATA_LIVES: ResidencyRow[] = [
  { data: "Workspace data: mail (including synced copies of connected mailboxes), attachments, tasks, contacts, docs, chat and uploaded files", where: "Oceania region (Australia and New Zealand)", region: "au", detail: "One primary database, placed in our hosting provider's Oceania region, with no read copies elsewhere. Attachments and files are stored in the same database. The provider treats a region as a location hint and does not promise a country." },
  { data: "App servers that handle your requests", where: "Sydney", region: "au", detail: "Requests are processed next to the database. Static pages, and the first hop of each connection, are served from the nearest edge location worldwide." },
  { data: "Sign in accounts: name, email, sign in method, second factor", where: "Australia", region: "au", detail: "Our sign in provider's Australian region, for accounts made from 25 October 2026. Accounts made before then can still sign in through the provider's United States region until they are moved." },
  { data: "Live doc editing rooms", where: "Chosen by our hosting provider", region: "mixed", detail: "Short lived. A room holds edits while people are in the doc, then its storage is deleted. The saved doc lives in the database." },
  { data: "Files you upload to import mail or work", where: "Not pinned to a region", region: "mixed", detail: "Held in our hosting provider's key value store until the import finishes, 7 days at most, then deleted." },
  { data: "Mail you send to addresses outside Multies (your domain or a free address)", where: "United States", region: "outside", detail: "Passes through our outbound email provider. Mail sent from a connected mailbox goes out through that mailbox's own provider instead." },
  { data: "Error reports", where: "United States", region: "outside", detail: "Account ids and technical details, no message content." },
  { data: "Payments and invoices", where: "Australia and United States", region: "outside", detail: "Only for paid add ons. Card details are held by our payments provider, never by Multies." },
  { data: "Video meetings", where: "United States", region: "outside", detail: "Only while a meeting is running." },
  { data: "Phone app push notifications", where: "United States", region: "outside", detail: "Only when turned on. A device token and message ids, no message text." },
  { data: "Encrypted database backups", where: "United States", region: "outside", detail: "Taken before releases that change the database, encrypted, and deleted after 30 days. Our provider's own point in time restore stays with the database." },
  { data: "An earlier copy of the database (data up to 24 October 2026)", where: "United States (North America region)", region: "outside", detail: "Kept idle while the move to the Oceania region settles, then deleted. Nothing new is written to it." },
  { data: "Files you run through Tools (compress, merge, convert and the other document tools)", where: "Singapore", region: "outside", detail: "Processed on our document engine in Singapore. Each input file is deleted right after its job, and everything is deleted within 1 hour." },
  { data: "Your own AI provider, if you add a key", where: "Set by the provider you choose", region: "mixed", detail: "Off unless your workspace adds its own key. Only the thread you ask the assistant about, or the document text an AI document helper reads, is sent." },
  // Tools P2: these rows apply only when a workspace uses the feature (each is off on production until it ships).
  { data: "Document text read by the AI document helpers (ask a document, translate, invoices, expense reports, contract dates)", where: "Our hosting provider's network, may be outside Australia", region: "mixed", detail: "Only when your workspace uses these helpers. The text goes to our infrastructure provider's AI service, or to your workspace's own AI provider when an admin adds a key. It is not used for training and is not kept after the answer." },
  { data: "Text from attachments (search index for search inside attachments and smart folders)", where: "Our hosting provider's database, separate from mail", region: "mixed", detail: "Only when your workspace uses search inside attachments. Kept in a separate search index until the message is deleted or search inside attachments is turned off. Not included in backups; it can be rebuilt from your mail." },
  { data: "Share link files, files waiting for signatures, and mail merge PDFs", where: "Not pinned to a region", region: "mixed", detail: "Only when your workspace uses these features. Held in our hosting provider's key value store with their own expiry: share and signing files up to 30 days, mail merge PDFs up to 3 days, then deleted." },
];

export const JURISDICTION: string[] = [
  "Multies is provided by Fintex Australia Pty Ltd, an Australian company, under the laws of New South Wales.",
  "We handle personal information under the Privacy Act 1988 and the Australian Privacy Principles. Where a provider above is outside Australia, that is an overseas disclosure under APP 8, explained in our privacy policy.",
  "Australia only storage is not offered today. We will say so on this page, and in our privacy policy, only when every store above is in Australia.",
];

export interface Step { title: string; body: string }

/** Ways to evaluate Multies without connecting a client mailbox. Both are live features (DEMO_MODE, FREE_MAIL_DOMAIN). */
export const SAFE_TRIAL: Step[] = [
  { title: "Open the live demo", body: "A sample workspace with made up mail, tasks, docs and deals. No sign up, nothing of yours goes in, and it is deleted after 24 hours. On busy days the demo rests until the next day." },
  { title: "Take a free test address", body: "Sign up free and take an address like yourname@mail.multies.si. Send and receive real mail with it, try tasks, chat and meetings, and leave every client mailbox where it is. Up to 50 sends a day." },
  { title: "Connect a real mailbox only when you are ready", body: "Connecting a mailbox copies its mail into Multies, stored in the Oceania region. The original stays at your provider. Removing the connection deletes our copy and its password straight away." },
];

/** What Multies can take over, with the honest edge of each. No competitor names. */
export const LESS_ADMIN: Step[] = [
  { title: "Keep your current address", body: "Connect your existing mailbox over IMAP (Google accounts work with an app password). Mail syncs both ways and replies go out through your own provider, so nothing changes for your clients. Or point your own domain at Multies when you want to move fully." },
  { title: "Bring your contacts", body: "Export your contacts from Google or any address book as a vCard (.vcf) or CSV and import the file. Contacts are matched by email address. There is no live two way contacts sync yet." },
  { title: "Turn mail into work in one place", body: "Make a task from any email, share an inbox with your team, and see every thread with a client beside their contact record. One sign in instead of separate mail, task and chat apps." },
  { title: "Bring your tasks", body: "Upload an export or any CSV or Excel file with a title column, check a preview, and undo the whole import if it is wrong." },
  { title: "Know the limits", body: "Multies does not replace your accounting or industry specific software. It connects to them through webhooks and the API, listed below." },
];

export interface Connection { name: string; status: "available" | "planned"; detail: string }

/** Connections that exist in this codebase today, and ones marked planned. Only real things. */
export const CONNECTIONS: Connection[] = [
  { name: "Existing mailboxes (IMAP)", status: "available", detail: "Sync mail both ways from any IMAP mailbox, Google accounts included with an app password, and send through the mailbox's own provider." },
  { name: "Calendar feed", status: "available", detail: "A private .ics feed of your meetings and task due dates for any calendar app." },
  { name: "Contacts, calendar and tasks files", status: "available", detail: "Import and export vCard, CSV, .ics and task exports." },
  { name: "Incoming webhooks", status: "available", detail: "Any tool that can send a webhook, including automation tools and web forms, can create tasks, contacts or deals in Multies." },
  { name: "Outgoing webhooks", status: "available", detail: "Send new mail, task and form events to any HTTPS address, a chat channel or an automation tool, and from there into a CRM." },
  { name: "REST API and MCP server", status: "available", detail: "Read and write mail, tasks, contacts and more with API keys, or connect an AI agent through MCP." },
  { name: "Your CRM or industry platform, through webhooks or the API (no ready made connector)", status: "available", detail: "If it can send or receive webhooks, or has an API, leads can flow between it and Multies through the webhooks above." },
  { name: "WhatsApp enquiries in the shared inbox", status: "planned", detail: "Built and being tested, not switched on. Planned, not available today." },
];

const cell = (s: string) => s.replace(/\|/g, "/");

/** The page section as Markdown, for /trust.md and llms-full.txt. */
export function residencyMarkdown(site: string): string {
  return [
    "# Multies: where your data lives, how to try it safely, and what it connects to",
    "",
    `> Checked ${RESIDENCY_CHECKED}. Source of truth for ${site}/trust, ${site}/privacy and ${site}/pricing.`,
    "",
    "## Where your data lives",
    "",
    RESIDENCY_ANSWER,
    "",
    "| Data | Where | Notes |",
    "| --- | --- | --- |",
    ...WHERE_DATA_LIVES.map((r) => `| ${cell(r.data)} | ${cell(r.where)} | ${cell(r.detail)} |`),
    "",
    "## Jurisdiction and data residency",
    "",
    ...JURISDICTION.map((j) => `- ${j}`),
    "",
    "## Try Multies without connecting a client mailbox",
    "",
    ...SAFE_TRIAL.map((s, i) => `${i + 1}. **${s.title}.** ${s.body}`),
    "",
    `Live demo and sign up: ${site}/ . Free plan: ${site}/pricing .`,
    "",
    "## Less admin, not more",
    "",
    ...LESS_ADMIN.map((s) => `- **${s.title}.** ${s.body}`),
    "",
    "## Connections",
    "",
    "| Connection | Status | What it does |",
    "| --- | --- | --- |",
    ...CONNECTIONS.map((c) => `| ${cell(c.name)} | ${c.status === "planned" ? "Planned" : "Available today"} | ${cell(c.detail)} |`),
    "",
  ].join("\n");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Plain HTML for readers that do not run scripts (crawlers, AI assistants fetching a page as text). The worker puts
 * it inside #root on the pages listed in STATIC_FACTS_PATHS; the app replaces it the moment it starts. The page renders
 * the same facts visibly, from the same arrays, so this is not hidden content.
 */
export const STATIC_FACTS_PATHS = new Set(["/trust", "/security", "/privacy", "/pricing", "/switch"]);
export function residencyStaticHtml(): string {
  const rows = WHERE_DATA_LIVES.map((r) => `<tr><td>${esc(r.data)}</td><td>${esc(r.where)}</td><td>${esc(r.detail)}</td></tr>`).join("");
  const conns = CONNECTIONS.map((c) => `<li>${esc(c.name)} (${c.status === "planned" ? "planned" : "available today"}): ${esc(c.detail)}</li>`).join("");
  return [
    // Visually hidden (the sr-only pattern) so there is no flash before the app paints; readers that ignore CSS get every word.
    '<article data-static-facts style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:normal;border:0">',
    "<h2>Where your data lives</h2>",
    `<p>${esc(RESIDENCY_ANSWER)}</p>`,
    `<table><thead><tr><th>Data</th><th>Where</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table>`,
    "<h2>Jurisdiction and data residency</h2>",
    `<ul>${JURISDICTION.map((j) => `<li>${esc(j)}</li>`).join("")}</ul>`,
    "<h2>Try Multies without connecting a client mailbox</h2>",
    `<ol>${SAFE_TRIAL.map((s) => `<li><strong>${esc(s.title)}.</strong> ${esc(s.body)}</li>`).join("")}</ol>`,
    "<h2>Less admin, not more</h2>",
    `<ul>${LESS_ADMIN.map((s) => `<li><strong>${esc(s.title)}.</strong> ${esc(s.body)}</li>`).join("")}</ul>`,
    "<h2>Connections</h2>",
    `<ul>${conns}</ul>`,
    `<p>Checked ${esc(RESIDENCY_CHECKED)}. Full details: <a href="/trust">/trust</a>, <a href="/privacy">/privacy</a>, <a href="/trust.md">/trust.md</a>.</p>`,
    "</article>",
  ].join("");
}
