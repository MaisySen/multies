/**
 * R76: the public developer hub at /developers. One place that points at everything a developer needs:
 * the REST API reference and its OpenAPI file, the MCP server and its tool list, webhooks, keys and the
 * agent inboxes guide. Static content only (no data reads), so it paints from the shell with no wait.
 */
import { Link } from "react-router";
import { IconAgent, IconArrowRight, IconCode, IconFileCode, IconKey, IconRadio } from "@/web/components/ui/icon";
import { CopyButton } from "@/web/components/ui/misc";
import { WEBHOOK_EVENT_GROUPS } from "@/shared/developer-hub";

const BASE = typeof window !== "undefined" ? window.location.origin : "https://multies.si";

interface Card { title: string; body: string; href: string; cta: string; icon: typeof IconCode; internal?: boolean }

const CARDS: Card[] = [
  { title: "REST API", body: "Mail, domains, tasks, docs, calendar and contacts over plain HTTPS with JSON. Every route, field and error is in the reference.", href: "/api/v1/reference", cta: "Open the API reference", icon: IconCode },
  { title: "MCP tools", body: "Connect any MCP client to your workspace. The tool list is generated from the server itself, with the key scope each tool needs.", href: "/developers/mcp", cta: "Browse the MCP tools", icon: IconFileCode, internal: true },
  { title: "Agent inboxes", body: "Give an AI agent its own address on your domain. Mail arrives as clean JSON and a person approves what it sends.", href: "/agents", cta: "Read the agents guide", icon: IconAgent, internal: true },
  { title: "Webhooks", body: "Get an HTTPS call the moment something happens. Every call is signed with the Standard Webhooks scheme and retried for up to a day.", href: "#webhooks", cta: "See the events", icon: IconRadio, internal: true },
];

function Ext({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return <a href={href} className={className}>{children}</a>;
}

export function DevelopersPage() {
  const curl = `curl ${BASE}/api/v1/domains \\\n  -H "Authorization: Bearer $MULTIES_KEY"`;
  return (
    <div className="pb-24">
      <section className="pt-32 sm:pt-40">
        <div className="mx-auto max-w-4xl px-5 text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1 text-xs text-muted"><IconCode className="h-3.5 w-3.5" aria-hidden />Developers</span>
          <h1 className="mt-5 text-4xl font-semibold leading-[1.08] tracking-[-0.03em] sm:text-5xl">Build on Multies</h1>
          <p className="mx-auto mt-6 max-w-2xl text-[17px] leading-relaxed text-muted">A REST API, an MCP server and signed webhooks for mail on your own domain, tasks, docs and agents. One key, scoped to exactly what it needs.</p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Ext href="/api/v1/reference" className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-brand px-5 text-[15px] font-medium text-brand-fg hover:bg-brand/90">API reference <IconArrowRight className="h-4 w-4" aria-hidden /></Ext>
            <Link to="/developers/mcp" className="inline-flex h-11 items-center justify-center rounded-lg border border-line px-5 text-[15px] font-medium hover:bg-hover">MCP tools</Link>
          </div>
        </div>
      </section>

      <section className="mx-auto mt-20 max-w-5xl px-5" aria-labelledby="start">
        <h2 id="start" className="sr-only">Where to start</h2>
        <ul className="grid gap-4 sm:grid-cols-2">
          {CARDS.map((c) => {
            const Icon = c.icon;
            const inner = (
              <>
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-soft text-brand-hover"><Icon className="h-5 w-5" aria-hidden /></span>
                <h3 className="mt-4 text-[17px] font-semibold">{c.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{c.body}</p>
                <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-brand-hover">{c.cta}<IconArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden /></span>
              </>
            );
            const cls = "group block h-full rounded-2xl border border-line bg-surface p-6 shadow-card transition-colors hover:border-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand";
            return (
              <li key={c.title}>
                {c.internal && !c.href.startsWith("#") ? <Link to={c.href} className={cls}>{inner}</Link> : <a href={c.href} className={cls}>{inner}</a>}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="mx-auto mt-20 max-w-5xl px-5" aria-labelledby="keys">
        <div className="grid gap-8 md:grid-cols-[1fr_1.3fr] md:items-start">
          <div>
            <h2 id="keys" className="flex items-center gap-2 text-2xl font-semibold tracking-tight"><IconKey className="h-5 w-5 text-brand-hover" aria-hidden />Keys and scopes</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted">Create a key in the app under Settings, Developers. Pick only the scopes it needs, such as mail:read or tasks:write. A read only key can never change anything, and you can revoke a key at any time.</p>
            <p className="mt-3 text-sm leading-relaxed text-muted">The OpenAPI file is at <a href="/api/v1/openapi.json" className="font-mono text-fg underline underline-offset-2">/api/v1/openapi.json</a> for code generators.</p>
            <Link to="/signup" className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-brand-hover hover:underline">Create a free account to get a key<IconArrowRight className="h-4 w-4" aria-hidden /></Link>
          </div>
          <figure className="min-w-0 overflow-hidden rounded-xl border border-line bg-surface">
            <figcaption className="flex items-center justify-between border-b border-line px-4 py-2 text-xs text-subtle"><span>Your first call</span><CopyButton value={curl} /></figcaption>
            <pre tabIndex={0} className="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed text-fg/90">{curl}</pre>
          </figure>
        </div>
      </section>

      <section className="mx-auto mt-20 max-w-5xl scroll-mt-24 px-5" id="webhooks" aria-labelledby="webhooks-h">
        <h2 id="webhooks-h" className="flex items-center gap-2 text-2xl font-semibold tracking-tight"><IconRadio className="h-5 w-5 text-brand-hover" aria-hidden />Webhooks</h2>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">Add an endpoint under Settings, Developers and pick the events. Each call carries webhook-id, webhook-timestamp and webhook-signature headers, so any Standard Webhooks library can check it. Failed calls are retried with backoff.</p>
        <dl className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {WEBHOOK_EVENT_GROUPS.map((g) => (
            <div key={g.label} className="rounded-xl border border-line p-4">
              <dt className="text-sm font-semibold">{g.label}</dt>
              <dd className="mt-2 flex flex-wrap gap-1.5">{g.events.map((e) => <code key={e} className="rounded-md bg-fill px-1.5 py-0.5 font-mono text-[12px] text-muted">{e}</code>)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mx-auto mt-20 max-w-5xl px-5" aria-labelledby="more">
        <h2 id="more" className="text-2xl font-semibold tracking-tight">For tools and assistants</h2>
        <ul className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
          <li><a href="/developers/mcp.md" className="block rounded-xl border border-line p-4 hover:bg-hover"><span className="font-medium">MCP tools as Markdown</span><span className="mt-1 block text-muted">The same list in one plain file.</span></a></li>
          <li><a href="/llms.txt" className="block rounded-xl border border-line p-4 hover:bg-hover"><span className="font-medium">llms.txt</span><span className="mt-1 block text-muted">A short map of Multies for language models.</span></a></li>
          <li><Link to="/status" className="block rounded-xl border border-line p-4 hover:bg-hover"><span className="font-medium">System status</span><span className="mt-1 block text-muted">Live health of the API and mail.</span></Link></li>
        </ul>
      </section>
    </div>
  );
}
