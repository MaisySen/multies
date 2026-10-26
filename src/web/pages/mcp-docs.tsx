/**
 * R36: public MCP tool docs at /developers/mcp. Every tool comes from /api/mcp-tools, which the server
 * builds from its own tool registrations, so this page can never list a tool the server lacks or miss
 * one it has. Search, an anchor per tool (#tool-name), the scope each needs, a parameter table, and an
 * example call and result with copy buttons. Recipes (src/shared/mcp-recipes.ts) are checked by a test.
 */
import { useEffect, useMemo, useState, type ComponentType } from "react";
import { IconArrowRight, IconCalendar, IconChat, IconCode, IconDocs, IconKey, IconMail, IconSearch, IconShield, IconTasks, IconUser } from "@/web/components/ui/icon";
import { CopyButton } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";
import { MCP_RECIPES } from "@/shared/mcp-recipes";

const BASE = typeof window !== "undefined" ? window.location.origin : "https://multies.si";

interface Param { name: string; type: string; required: boolean; description: string; default?: unknown; values?: string[] }
interface Tool { name: string; title: string; description: string; area: string; areaLabel: string; scope: string; readOnly: boolean; destructive: boolean; params: Param[]; example: { arguments: Record<string, unknown>; result: unknown; resultIsShape: boolean } }

const AREA_ICONS: Record<string, ComponentType<{ className?: string }>> = { mail: IconMail, tasks: IconTasks, chat: IconChat, docs: IconDocs, calendar: IconCalendar, contacts: IconUser, admin: IconShield };

function Block({ code, label }: { code: string; label: string }) {
  return (
    <figure className="min-w-0 overflow-hidden rounded-xl border border-line bg-surface">
      <figcaption className="flex items-center justify-between border-b border-line px-3 py-1.5 text-xs text-subtle"><span>{label}</span><CopyButton value={code} /></figcaption>
      <pre tabIndex={0} className="max-h-72 overflow-auto p-3 font-mono text-[12px] leading-relaxed text-fg/90">{code}</pre>
    </figure>
  );
}

const callJson = (t: Pick<Tool, "name"> & { arguments: Record<string, unknown> }) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: t.name, arguments: t.arguments } }, null, 2);

function ScopeChip({ scope }: { scope: string }) {
  return <span className="inline-flex items-center gap-1 rounded-full border border-line bg-fill px-2 py-0.5 font-mono text-[11px] text-muted"><IconKey className="h-3 w-3" aria-hidden />{scope}</span>;
}

function ToolCard({ t }: { t: Tool }) {
  return (
    <article id={t.name} className="scroll-mt-28 rounded-2xl border border-line bg-surface p-5 shadow-card" data-testid="mcp-tool">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="font-mono text-[15px] font-semibold"><a href={`#${t.name}`} className="hover:underline">{t.name}</a></h3>
        <ScopeChip scope={t.scope} />
        <span className={cn("rounded-full px-2 py-0.5 text-[11px]", t.readOnly ? "bg-ok-soft text-ok" : t.destructive ? "bg-bad-soft text-bad" : "bg-brand-soft text-brand-hover")}>{t.readOnly ? "Reads" : t.destructive ? "Deletes" : "Writes"}</span>
        <CopyButton value={`${BASE}/developers/mcp#${t.name}`} label="Copy link" className="ml-auto" />
      </header>
      <p className="mt-2 text-sm leading-relaxed text-muted">{t.description}</p>
      {t.params.length > 0 ? (
        <div className="mt-4 overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-left text-[13px]">
            <caption className="sr-only">Parameters of {t.name}</caption>
            <thead className="bg-fill/60 text-xs text-subtle"><tr><th scope="col" className="px-3 py-2 font-medium">Parameter</th><th scope="col" className="px-3 py-2 font-medium">Type</th><th scope="col" className="px-3 py-2 font-medium">Description</th></tr></thead>
            <tbody className="divide-y divide-line">
              {t.params.map((p) => (
                <tr key={p.name} className="align-top">
                  <td className="whitespace-nowrap px-3 py-2 font-mono">{p.name}{p.required ? <span className="ml-1 text-[10px] font-sans text-bad">required</span> : null}</td>
                  <td className="px-3 py-2 text-muted">{p.type}{p.values ? <span className="block font-mono text-[11px] text-subtle">{p.values.join(" | ")}</span> : null}</td>
                  <td className="px-3 py-2 text-muted">{p.description}{p.default !== undefined ? <span className="text-subtle"> Default {JSON.stringify(p.default)}.</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="mt-3 text-xs text-subtle">No parameters.</p>}
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <Block label="Example call" code={callJson({ name: t.name, arguments: t.example.arguments })} />
        <Block label={t.example.resultIsShape ? "Result shape" : "Example result"} code={JSON.stringify(t.example.result, null, 2)} />
      </div>
    </article>
  );
}

export function McpDocsPage() {
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState("");
  useEffect(() => {
    let live = true;
    fetch("/api/mcp-tools").then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then((b: { tools: Tool[] }) => { if (live) setTools(b.tools); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);
  // Jump to the anchor once the list is there (the page loads it after first paint).
  useEffect(() => {
    if (!tools || !window.location.hash) return;
    document.getElementById(decodeURIComponent(window.location.hash.slice(1)))?.scrollIntoView();
  }, [tools]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (tools ?? []).filter((t) => !needle || t.name.includes(needle) || t.title.toLowerCase().includes(needle) || t.description.toLowerCase().includes(needle) || t.scope.includes(needle) || t.params.some((p) => p.name.toLowerCase().includes(needle)));
    const out = new Map<string, { label: string; tools: Tool[] }>();
    for (const t of list) { const g = out.get(t.area) ?? { label: t.areaLabel, tools: [] }; g.tools.push(t); out.set(t.area, g); }
    return [...out.entries()];
  }, [tools, q]);
  const shown = groups.reduce((n, [, g]) => n + g.tools.length, 0);

  return (
    <>
      <section className="pt-28 sm:pt-36">
        <div className="mx-auto max-w-5xl px-5">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1 text-xs text-muted"><IconCode className="h-3.5 w-3.5" aria-hidden />Developers</span>
          <h1 className="mt-5 text-4xl font-semibold leading-[1.08] tracking-[-0.03em] sm:text-5xl">MCP tools</h1>
          <p className="mt-5 max-w-2xl text-[17px] leading-relaxed text-muted">
            Every tool the Multies MCP server offers{tools ? `, all ${tools.length} of them` : ""}, read straight from the server. Each one shows the key scope it needs, its parameters and an example.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-2 text-sm">
            <code className="rounded-lg border border-line bg-surface px-3 py-2 font-mono text-[13px]">{BASE}/api/v1/mcp</code>
            <CopyButton value={`${BASE}/api/v1/mcp`} label="Copy server URL" />
            <a href="/agents#mcp" className="ml-1 inline-flex items-center gap-1 text-brand-hover hover:underline">Connect a client <IconArrowRight className="h-3.5 w-3.5" aria-hidden /></a>
            <a href="/developers/mcp.md" className="ml-3 text-muted hover:text-fg hover:underline">Markdown</a>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-5 pt-14" aria-labelledby="recipes">
        <h2 id="recipes" className="text-2xl font-semibold tracking-tight">Examples</h2>
        <p className="mt-2 text-sm text-muted">Ask your agent in plain words. These are the calls it makes.</p>
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {MCP_RECIPES.map((r) => (
            <details key={r.id} id={`recipe-${r.id}`} className="group rounded-2xl border border-line bg-surface p-5 shadow-card open:md:col-span-2">
              <summary className="cursor-pointer list-none">
                <h3 className="font-semibold">{r.title}</h3>
                <p className="mt-1 text-sm text-muted">{r.summary}</p>
                <p className="mt-3 flex flex-wrap gap-1.5">{r.scopes.map((s) => <ScopeChip key={s} scope={s} />)}</p>
              </summary>
              <blockquote className="mt-4 rounded-xl bg-fill/60 px-4 py-3 text-sm italic text-muted">"{r.prompt}"</blockquote>
              <ol className="mt-4 space-y-3">
                {r.steps.map((s, i) => (
                  <li key={i} className="grid gap-2 md:grid-cols-[1fr_1.4fr]">
                    <p className="text-sm"><span className="mr-1 font-mono text-subtle">{i + 1}.</span><a href={`#${s.tool}`} className="font-mono text-brand-hover hover:underline">{s.tool}</a> <span className="text-muted">{s.why}</span></p>
                    <Block label="Call" code={callJson({ name: s.tool, arguments: s.arguments })} />
                  </li>
                ))}
              </ol>
            </details>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-5 py-14" aria-labelledby="all-tools">
        <div className="sticky top-14 z-10 -mx-5 border-b border-line bg-bg/80 px-5 py-3 backdrop-blur-xl">
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="all-tools" className="text-lg font-semibold">All tools</h2>
            <label className="relative ml-auto w-full sm:w-72">
              <span className="sr-only">Search tools</span>
              <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tools, scopes, parameters" className="h-10 w-full rounded-xl border border-line bg-surface pl-9 pr-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/30" />
            </label>
          </div>
          {tools ? (
            <nav aria-label="Areas" className="mt-2 flex gap-1.5 overflow-x-auto text-xs">
              {groups.map(([area, g]) => <a key={area} href={`#area-${area}`} className="whitespace-nowrap rounded-full bg-fill px-2.5 py-1 text-muted hover:text-fg">{g.label} {g.tools.length}</a>)}
            </nav>
          ) : null}
        </div>
        {failed ? <p className="mt-8 text-sm text-bad">The tool list did not load. Try again, or read <a className="underline" href="/developers/mcp.md">the Markdown copy</a>.</p> : null}
        {!tools && !failed ? (
          <div className="mt-8 space-y-4" aria-busy="true" aria-label="Loading tools">
            {[0, 1, 2].map((i) => <div key={i} className="h-40 animate-pulse rounded-2xl bg-fill" />)}
          </div>
        ) : null}
        {tools && shown === 0 ? <p className="mt-10 text-center text-sm text-muted">No tool matches "{q}".</p> : null}
        {groups.map(([area, g]) => {
          const Icon = AREA_ICONS[area] ?? IconCode;
          return (
            <section key={area} id={`area-${area}`} className="scroll-mt-32 pt-10" aria-labelledby={`h-${area}`}>
              <h2 id={`h-${area}`} className="flex items-center gap-2 text-xl font-semibold tracking-tight"><Icon className="h-5 w-5 text-brand-hover" />{g.label}<span className="text-sm font-normal text-subtle">{g.tools.length}</span></h2>
              <div className="mt-4 space-y-4">{g.tools.map((t) => <ToolCard key={t.name} t={t} />)}</div>
            </section>
          );
        })}
      </section>
    </>
  );
}
