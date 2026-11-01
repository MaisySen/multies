/**
 * Titles and descriptions for every public page. Pure data, so the Worker can import it to put the same
 * tags into the HTML shell before the app loads. The client applies them on every navigation (main.tsx).
 */
import { freeHeadline } from "../../shared/free-plan";
import { SWITCH_SOURCES } from "../../shared/switch-sources";
import { AREAS } from "../../shared/marketing-areas";

export const SITE_URL = "https://multies.si";
export const OG_IMAGE = `${SITE_URL}/og-image.png`;

/** image: the shared link preview picture (W1: one per product area); OG_IMAGE when unset. */
export interface PageMeta { title: string; description: string; noindex?: boolean; image?: string }

const DEFAULT: PageMeta = {
  title: "Multies: one workspace for your team, on your own domain",
  description: "Mail on your own domain with tasks, chat, docs, files, meetings, booking, contacts, invoices and signing in one place. AI agents help, a person approves. Free to start.",
  image: `${SITE_URL}/og/home.jpg`,
};

/** R60: /trust and /security. The description answers the residency question for readers that only see the head. */
const TRUST_META = { title: "Security and data | Multies", description: "Where Multies stores each kind of data (workspace data in the Oceania region, sign in in Australia, some services in the United States; not Australia only), how to try it without a client mailbox, connections, backups and incidents." };

export const PUBLIC_META: Record<string, PageMeta> = {
  "/": DEFAULT,
  "/pricing": { title: "Pricing | Multies", description: "Free for one domain and three mailboxes. Add-ons cost A$1 to A$5 a month for the whole business, never per person. Prices in AUD. Try it with the live demo or a free test address, no client mailbox needed.", image: `${SITE_URL}/og/home.jpg` },
  "/agents": { title: "Email inboxes for AI agents | Multies", description: "Give each AI agent its own address with one API call. Mail arrives as clean JSON, replies stay in the thread, and a person approves what agents send." },
  // R76: /developers/mcp shipped in R36 without an entry here, so its title, link previews and search results read
  // "Page not found" and it carried noindex. A unit test now checks every page in known-routes.ts has an entry.
  "/developers": { title: "Developers: API, MCP and webhooks | Multies", description: "Build on Multies with a REST API, an MCP server and signed webhooks for mail on your own domain, tasks, docs and agents. Scoped keys, an OpenAPI file and a generated tool list." },
  "/developers/mcp": { title: "MCP tools | Multies", description: "Every tool the Multies MCP server offers, generated from the server itself: what each does, the key scope it needs, its parameters and an example call and result." },
  "/check": { title: "Check your domain's email | Multies", description: "Free check: see who hosts your domain's mail, whether SPF and DMARC are set, and the steps to switch to Multies without losing a message." },
  "/trust": TRUST_META,
  "/security": TRUST_META,
  "/status": { title: "System status | Multies", description: "Live status of Multies' web app, API, inbound mail and outbound delivery." },
  "/changelog": { title: "What's new | Multies", description: "What changed in Multies, newest first: new features, fixes and speed improvements." },
  "/whats-new": { title: "What's new | Multies", description: "New in Multies, newest first: invoices and quotes, booking, Ask, contracts, files, newsletters and more.", image: `${SITE_URL}/og/whats-new.jpg` },
  // W1: the features list and one page per product area, each with its own link preview picture.
  "/features": { title: "Features | Multies", description: "Mail, tasks, chat, docs, files, meetings, booking, contacts, invoices, signing, social and AI agents, in one workspace on your own domain.", image: `${SITE_URL}/og/features.jpg` },
  ...Object.fromEntries(AREAS.map((a) => [`/features/${a.slug}`, { title: a.title, description: a.description, image: `${SITE_URL}/og/${a.slug}.jpg` }])),
  "/privacy": { title: "Privacy policy | Multies", description: "What Multies collects, why, where it is processed and how to delete it. Workspace data, including synced mail, is stored in the Oceania region; some services run in the United States. Not Australia only." },
  "/terms": { title: "Terms of service | Multies", description: "The terms for using Multies' email, work management and agent features." },
  "/acceptable-use": { title: "Acceptable use policy | Multies", description: "What you may and may not send or store with Multies." },
  "/dpa": { title: "Data processing agreement | Multies", description: "How Multies processes personal data on behalf of your business." },
  "/support": { title: "Support | Multies", description: "Get help with Multies by email, with answers to common questions about mail, domains and accounts." },
  "/delete-account": { title: "Delete your account | Multies", description: "How to delete your Multies account and data, in the app, on the web or through the API." },
  "/login": { title: "Sign in | Multies", description: "Sign in to your Multies workspace for mail, tasks, chat and agents." },
  "/signup": { title: "Create your free account | Multies", description: "Start with one domain and three mailboxes free, no card needed." },
  "/forgot-password": { title: "Reset your password | Multies", description: "Get a link to set a new Multies password.", noindex: true },
  "/reset-password": { title: "Choose a new password | Multies", description: "Set a new password for your Multies account.", noindex: true },
  "/email-verified": { title: "Email verified | Multies", description: "Your email address is confirmed.", noindex: true },
  "/contact": { title: "Contact us | Multies", description: "Send the Multies team a message: questions, a demo for your team, or help moving your mail. We reply within one business day." },
  "/thank-you": { title: "Thank you | Multies", description: "Thanks for getting in touch with Multies. We reply within one business day.", noindex: true },
  "/thanks": { title: "Thank you | Multies", description: "Thanks for getting in touch with Multies.", noindex: true },
  // R58 (MB-237): the free plan page and the switch pages. The free plan numbers come from plans.ts.
  "/startups": { title: "Free for startups and small teams | Multies", description: `${freeHeadline()} Mail on your own domain with tasks, chat and docs, no card and no trial clock.` },
  "/switch": { title: "Move your work to Multies | Multies", description: "Bring your tasks over from the tool you use now: export a file, upload it, check a preview, and undo the whole import if you change your mind." },
  ...Object.fromEntries(SWITCH_SOURCES.map((s) => [`/switch/${s.slug}`, {
    title: `Import from ${s.label} | Multies`,
    description: `Bring your ${s.label} work into Multies: export ${s.file}, upload it, check the columns and a preview, then import. Try it with a sample file first.`,
  }])),
};

export const NOT_FOUND_META: PageMeta = { title: "Page not found | Multies", description: "This address doesn't exist on Multies.", noindex: true };

/** The meta for a path: a public page, the signed-in app, or not found. */
export function metaFor(path: string): PageMeta {
  const clean = path.replace(/\/+$/, "") || "/";
  if (PUBLIC_META[clean]) return PUBLIC_META[clean];
  // R93: public forms and feedback boards are real pages with their own titles, so shared links preview well.
  if (clean.startsWith("/f/")) return { title: "Form | Multies", description: "Answer a short form shared with you on Multies. It takes a minute.", noindex: true };
  if (clean.startsWith("/fb/")) return { title: "Feedback board | Multies", description: "Share ideas, vote on what matters most and follow the roadmap on Multies.", noindex: true };
  if (clean === "/app" || clean.startsWith("/app/") || clean.startsWith("/invite/") || clean.startsWith("/m/") || clean.startsWith("/g/") || clean === "/guest") {
    return { title: "Multies", description: DEFAULT.description, noindex: true };
  }
  // R92: public booking pages (book a time, time polls, events, tickets) are real pages; shared links must not preview as not found.
  if (clean.startsWith("/book/")) {
    return { title: "Booking | Multies", description: "Book a time, answer a time poll or get a free event ticket on Multies.", noindex: true };
  }
  // R114: webinar registration, attendee and replay pages are real public pages; a shared registration link must not preview as not found.
  if (clean.startsWith("/w/")) {
    return { title: "Webinar | Multies", description: "Register for a webinar on Multies, then watch, ask questions and vote in polls from your own link.", noindex: true };
  }
  return NOT_FOUND_META;
}
