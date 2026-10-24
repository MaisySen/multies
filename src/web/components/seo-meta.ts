/**
 * Titles and descriptions for every public page. Pure data, so the Worker can import it to put the same
 * tags into the HTML shell before the app loads. The client applies them on every navigation (main.tsx).
 */
export const SITE_URL = "https://mymail.mymail-app.workers.dev";
export const OG_IMAGE = `${SITE_URL}/og-image.png`;

export interface PageMeta { title: string; description: string; noindex?: boolean }

const DEFAULT: PageMeta = {
  title: "MyMail: email on your own domain, with tasks, chat and agents",
  description: "Professional email on the domain you own, with tasks, team chat, docs and AI agent inboxes built in. Free for small teams, add-ons from A$1 a month.",
};

export const PUBLIC_META: Record<string, PageMeta> = {
  "/": DEFAULT,
  "/pricing": { title: "Pricing | MyMail", description: "Free for one domain and three mailboxes. Add-ons cost A$1 to A$5 a month for the whole business, never per person. Prices in AUD, GST included." },
  "/agents": { title: "Email inboxes for AI agents | MyMail", description: "Give each AI agent its own address with one API call. Mail arrives as clean JSON, replies stay in the thread, and a person approves what agents send." },
  "/status": { title: "System status | MyMail", description: "Live status of MyMail's web app, API and mail delivery." },
  "/privacy": { title: "Privacy policy | MyMail", description: "What MyMail collects, why, where it is processed and how to delete it." },
  "/terms": { title: "Terms of service | MyMail", description: "The terms for using MyMail's email, work management and agent features." },
  "/acceptable-use": { title: "Acceptable use policy | MyMail", description: "What you may and may not send or store with MyMail." },
  "/dpa": { title: "Data processing agreement | MyMail", description: "How MyMail processes personal data on behalf of your business." },
  "/support": { title: "Support | MyMail", description: "Get help with MyMail by email, with answers to common questions about mail, domains and accounts." },
  "/delete-account": { title: "Delete your account | MyMail", description: "How to delete your MyMail account and data, in the app, on the web or through the API." },
  "/login": { title: "Sign in | MyMail", description: "Sign in to your MyMail workspace." },
  "/signup": { title: "Create your free account | MyMail", description: "Start with one domain and three mailboxes free, no card needed." },
  "/forgot-password": { title: "Reset your password | MyMail", description: "Get a link to set a new MyMail password.", noindex: true },
  "/reset-password": { title: "Choose a new password | MyMail", description: "Set a new password for your MyMail account.", noindex: true },
  "/email-verified": { title: "Email verified | MyMail", description: "Your email address is confirmed.", noindex: true },
  "/thanks": { title: "Thank you | MyMail", description: "Thanks for getting in touch with MyMail.", noindex: true },
};

export const NOT_FOUND_META: PageMeta = { title: "Page not found | MyMail", description: "This address doesn't exist on MyMail.", noindex: true };

/** The meta for a path: a public page, the signed-in app, or not found. */
export function metaFor(path: string): PageMeta {
  const clean = path.replace(/\/+$/, "") || "/";
  if (PUBLIC_META[clean]) return PUBLIC_META[clean];
  if (clean === "/app" || clean.startsWith("/app/") || clean.startsWith("/invite/") || clean.startsWith("/f/") || clean.startsWith("/m/") || clean.startsWith("/g/") || clean === "/guest") {
    return { title: "MyMail", description: DEFAULT.description, noindex: true };
  }
  return NOT_FOUND_META;
}
