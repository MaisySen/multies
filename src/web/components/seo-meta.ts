/**
 * Titles and descriptions for every public page. Pure data, so the Worker can import it to put the same
 * tags into the HTML shell before the app loads. The client applies them on every navigation (main.tsx).
 */
export const SITE_URL = "https://multies.si";
export const OG_IMAGE = `${SITE_URL}/og-image.png`;

export interface PageMeta { title: string; description: string; noindex?: boolean }

const DEFAULT: PageMeta = {
  title: "Multies: email on your own domain, with tasks, chat and agents",
  description: "Professional email on the domain you own, with tasks, team chat, docs and AI agent inboxes built in. Free for small teams, add-ons from A$1 a month.",
};

export const PUBLIC_META: Record<string, PageMeta> = {
  "/": DEFAULT,
  "/pricing": { title: "Pricing | Multies", description: "Free for one domain and three mailboxes. Add-ons cost A$1 to A$5 a month for the whole business, never per person. Prices in AUD." },
  "/agents": { title: "Email inboxes for AI agents | Multies", description: "Give each AI agent its own address with one API call. Mail arrives as clean JSON, replies stay in the thread, and a person approves what agents send." },
  "/check": { title: "Check your domain's email | Multies", description: "Free check: see who hosts your domain's mail, whether SPF and DMARC are set, and the steps to switch to Multies without losing a message." },
  "/trust": { title: "Security and data | Multies", description: "Where Multies stores your data, the services it uses, backups, sign in options, encryption and incident history." },
  "/status": { title: "System status | Multies", description: "Live status of Multies' web app, API, inbound mail and outbound delivery." },
  "/privacy": { title: "Privacy policy | Multies", description: "What Multies collects, why, where it is processed and how to delete it." },
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
};

export const NOT_FOUND_META: PageMeta = { title: "Page not found | Multies", description: "This address doesn't exist on Multies.", noindex: true };

/** The meta for a path: a public page, the signed-in app, or not found. */
export function metaFor(path: string): PageMeta {
  const clean = path.replace(/\/+$/, "") || "/";
  if (PUBLIC_META[clean]) return PUBLIC_META[clean];
  if (clean === "/app" || clean.startsWith("/app/") || clean.startsWith("/invite/") || clean.startsWith("/f/") || clean.startsWith("/m/") || clean.startsWith("/g/") || clean === "/guest") {
    return { title: "Multies", description: DEFAULT.description, noindex: true };
  }
  return NOT_FOUND_META;
}
