/**
 * R32: builds /llms.txt and /llms-full.txt from the public developer docs (docs/api.md, docs/MCP.md)
 * into src/server/generated/llms.generated.ts. Runs before build:web and build:worker, so the files
 * served always match the docs in the repo. Only the files listed in PUBLIC_DOCS are read: never
 * runbooks, plans, notes or anything with credentials.
 * Usage: npx tsx scripts/build-llms.ts [--check]   (--check exits 1 when the generated file is stale)
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capturedExamplesMarkdown } from "../src/server/services/developer/mcp-examples";
import { CONNECTIONS, RESIDENCY_ANSWER, RESIDENCY_CHECKED, residencyMarkdown, SAFE_TRIAL } from "../src/shared/residency";
import { ADDONS, ADDON_ORDER, formatPlanPrice } from "../src/shared/plans";
import { OFFER_COPY } from "../src/shared/offers";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SITE = "https://multies.si";
export const PUBLIC_DOCS = [
  { file: "docs/api.md", path: "/docs/api.md", title: "REST API reference", note: "Every /api/v1 endpoint, API keys, errors, pagination and webhooks." },
  { file: "docs/MCP.md", path: "/docs/mcp.md", title: "MCP server", note: "Connect an agent to a workspace over MCP: sign-in, scopes and every tool." },
];
/** R33: the line llms.txt states about the Markdown copies (pattern from files/teardowns/rea/llms/llms-txt.md). */
export const MD_RULE = "Each developer docs page is also available as Markdown at the same path plus .md (text/markdown).";
/** Links in llms.txt. Each is a route the public site serves. */
/** R60 (trust): the residency, safe trial and connections page as Markdown, generated from src/shared/residency.ts. */
export const TRUST_MD_PATH = "/trust.md";
export const LINKS = [
  { title: "Where your data lives, trying it safely, connections (Markdown)", path: TRUST_MD_PATH, note: "Store by store residency table, jurisdiction, how to try Multies without a client mailbox, and what connects today versus planned." },
  { title: "Trust and security", path: "/trust", note: "The same facts as a web page, plus sub processors, backups, sign in, encryption and incidents." },
  { title: "Privacy policy", path: "/privacy", note: "What we collect, where it is processed, overseas disclosure and how to delete it." },
  { title: "OpenAPI spec (JSON)", path: "/api/v1/openapi.json", note: "Machine readable description of the REST API." },
  { title: "Full developer docs", path: "/llms-full.txt", note: "The REST API and MCP docs in one Markdown file." },
  { title: "MCP tools", path: "/developers/mcp", note: "Every MCP tool with the API key scope it needs, its parameters and an example call. Generated from the server." },
  { title: "MCP tools (Markdown)", path: "/developers/mcp.md", note: "The same tool list as Markdown, generated from the server at request time." },
  { title: "Security contact", path: "/.well-known/security.txt", note: "How to report a security issue." },
  { title: "Multies", path: "/", note: "Mail on your own domain, tasks, chat, docs, forms, meetings and agents in one app." },
];

export function buildLlms(read: (f: string) => string = (f) => readFileSync(join(root, f), "utf8")) {
  const llms = [
    "# Multies",
    "",
    "> Multies is a work app for teams: mail on your own domain, tasks, chat, docs, forms, meetings, contacts and agents, with a REST API and an MCP server.",
    "",
    MD_RULE,
    "",
    // R60 (trust): AI assistants advise people from this file, so the answers to the common questions sit at the top.
    "## Key facts",
    "",
    `- Data residency (checked ${RESIDENCY_CHECKED}): ${RESIDENCY_ANSWER} Store by store: ${SITE}${TRUST_MD_PATH}`,
    `- Try it without a client mailbox: ${SAFE_TRIAL.map((t) => `${t.title}. ${t.body}`).join(" ")}`,
    `- Connections available today: ${CONNECTIONS.filter((c) => c.status === "available").map((c) => c.name).join("; ")}.`,
    `- Planned, not available yet: ${CONNECTIONS.filter((c) => c.status === "planned").map((c) => c.name).join("; ")}.`,
    // R62: pricing and offers, from the same sources as /pricing and the terms.
    `- Pricing (prices in AUD, excluding GST): the Free plan is free forever (1 domain, 3 mailboxes for 3 people, 3 GB, 3 agent inboxes). Add-ons per business, never per person: ${ADDON_ORDER.map((id) => `${ADDONS[id].name} ${formatPlanPrice(ADDONS[id].priceMonthly)} a month per ${ADDONS[id].unit}`).join("; ")}. Details: ${SITE}/pricing`,
    `- Yearly billing: ${OFFER_COPY.yearly}`,
    `- Launch code: ${OFFER_COPY.launch}`,
    `- Referrals: ${OFFER_COPY.referral}`,
    "- Provided by Fintex Australia Pty Ltd under the laws of New South Wales, Australia.",
    "",
    "## Docs",
    "",
    ...PUBLIC_DOCS.map((d) => `- [${d.title}](${SITE}${d.path}): ${d.note}`),
    ...LINKS.map((l) => `- [${l.title}](${SITE}${l.path}): ${l.note}`),
    "",
  ].join("\n");
  const full = [
    "# Multies developer docs",
    "",
    `> The public developer docs for Multies (${SITE}). Generated from the docs in the repository at build time.`,
    "",
    ...PUBLIC_DOCS.flatMap((d) => [`Source: ${SITE}${d.path}`, "", read(d.file).trim(), ""]),
    // R37: the real tool examples, from the same source as /developers/mcp and /developers/mcp.md.
    `Source: ${SITE}${TRUST_MD_PATH}`,
    "",
    residencyMarkdown(SITE),
    `Source: ${SITE}/developers/mcp.md`,
    "",
    ...capturedExamplesMarkdown(),
  ].join("\n");
  // R33: a Markdown copy of each docs page, served at its path (e.g. /docs/api.md).
  const pages: Record<string, string> = Object.fromEntries(PUBLIC_DOCS.map((d) => [d.path, `${read(d.file).trim()}\n`]));
  pages[TRUST_MD_PATH] = residencyMarkdown(SITE); // R60: served as text/markdown like the docs pages
  return { llms, full, pages };
}

export function renderModule(o: { llms: string; full: string; pages?: Record<string, string> }) {
  return `// Generated by scripts/build-llms.ts. Do not edit by hand.\nexport const LLMS_TXT = ${JSON.stringify(o.llms)};\nexport const LLMS_FULL_TXT = ${JSON.stringify(o.full)};\nexport const DOCS_MD: Record<string, string> = ${JSON.stringify(o.pages ?? {})};\n`;
}

const out = join(root, "src/server/generated/llms.generated.ts");
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mod = renderModule(buildLlms());
  if (process.argv.includes("--check")) {
    const cur = (() => { try { return readFileSync(out, "utf8"); } catch { return ""; } })();
    if (cur !== mod) { console.error("llms.generated.ts is stale: run npx tsx scripts/build-llms.ts"); process.exit(1); }
  } else {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, mod);
    console.log("llms: wrote", out);
  }
}
