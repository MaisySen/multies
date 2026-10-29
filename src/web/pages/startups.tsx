import { Link } from "react-router";
import { IconArrowRight, IconCheck } from "@/web/components/ui/icon";
import { ButtonLink } from "@/web/components/ui/button";
import { useSignedIn } from "@/web/lib/queries";
import { freeHeadline, freeLimits, growLine } from "@/shared/free-plan";
import { PLANS } from "@/shared/plans";
import { SWITCH_SOURCES } from "@/shared/switch-sources";

const card = "rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6";

const INCLUDED = [
  "Mail on your own domain, in the browser and the phone app",
  "Tasks, boards, docs and contacts in the same place as the mail",
  "Team chat, goals, templates and repeating tasks",
  "Bring your own AI: connect any AI app or agent through MCP",
  "Import your work from the tools you use now, and export everything any time",
];

/**
 * R58 (MB-237): the public free plan page for small teams. Every number comes from src/shared/plans.ts
 * through shared/free-plan.ts, so the page always shows the limits the server enforces.
 */
export function StartupsPage() {
  const signedIn = useSignedIn();
  const plan = PLANS.starter;
  const limits = freeLimits(plan);
  return (
    <article className="mx-auto max-w-4xl px-5 pb-24 pt-28 sm:pt-32" data-testid="free-plan-page">
      <p className="text-xs uppercase tracking-wide text-subtle">For startups and small teams</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Run your small team on Multies for free</h1>
      <p className="mt-3 max-w-2xl text-lg text-muted" data-testid="free-headline">{freeHeadline(plan)}</p>
      <p className="mt-2 max-w-2xl text-muted">No card and no trial clock. Mail, tasks, chat and docs in one place, on the domain you already own.</p>
      <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center">
        <ButtonLink to={signedIn ? "/app" : "/signup"} size="lg" className="max-sm:w-full" data-hero-cta data-testid="free-cta">
          {signedIn ? "Open your workspace" : "Create your free workspace"}<IconArrowRight className="h-4 w-4" aria-hidden />
        </ButtonLink>
        <Link to="/pricing" className="text-sm font-medium text-brand-hover hover:underline">See all prices</Link>
      </div>

      <section className="mt-14" aria-labelledby="free-limits">
        <h2 id="free-limits" className="text-xl font-semibold tracking-tight">What Free includes</h2>
        <p className="mt-1 text-sm text-muted">These are the exact limits. They are the same numbers the app checks.</p>
        <ul className="mt-5 grid gap-3 sm:grid-cols-2" data-testid="free-limits">
          {limits.map((l) => (
            <li key={l.key} className={card} data-testid={`free-limit-${l.key}`}>
              <p className="text-2xl font-semibold tabular-nums tracking-tight">{l.value}</p>
              <p className="mt-1 text-[14px] text-muted">{l.label}</p>
              {l.more && <p className="mt-3 text-[13px] text-subtle">{l.more}</p>}
            </li>
          ))}
        </ul>
        <ul className="mt-6 space-y-2.5">
          {INCLUDED.map((x) => (
            <li key={x} className="flex gap-2.5 text-[15px]"><IconCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden />{x}</li>
          ))}
        </ul>
      </section>

      <section className={`${card} mt-12`} aria-labelledby="free-past">
        <h2 id="free-past" className="text-lg font-semibold">What happens when you reach a limit</h2>
        <p className="mt-2 text-[15px] text-muted">Nothing you have is deleted and nothing is charged. Only the one thing past the limit waits: inviting one more person, adding one more mailbox, or sending past today's limit, which resets at midnight UTC. You see a plain message that names the add-on that lifts it.</p>
        <p className="mt-3 text-[15px] text-muted" data-testid="free-grow">{growLine(plan)}</p>
        <p className="mt-3 text-[15px] text-muted">Add-ons are priced for the whole workspace, never per person. <Link to="/pricing" className="font-medium text-brand-hover hover:underline">Work out your price</Link></p>
      </section>

      <section className="mt-12" aria-labelledby="free-switch">
        <h2 id="free-switch" className="text-lg font-semibold">Bring your work with you</h2>
        <p className="mt-1 text-[15px] text-muted">Upload the export from the tool you use now. You check the columns and see a preview first, and you can undo the whole import.</p>
        <ul className="mt-4 flex flex-wrap gap-2">
          {SWITCH_SOURCES.map((s) => (
            <li key={s.slug}><Link to={`/switch/${s.slug}`} className="inline-flex min-h-11 items-center rounded-full border border-line bg-surface px-4 text-sm font-medium hover:border-line-strong sm:min-h-9">{s.label}</Link></li>
          ))}
        </ul>
      </section>

      <section className="mt-14 text-center" aria-labelledby="free-start">
        <h2 id="free-start" className="text-2xl font-semibold tracking-tight">Start with your team today</h2>
        <p className="mx-auto mt-2 max-w-xl text-muted">{freeHeadline(plan)}</p>
        <ButtonLink to={signedIn ? "/app" : "/signup"} size="lg" className="mt-6 max-sm:w-full">
          {signedIn ? "Open your workspace" : "Create your free workspace"}<IconArrowRight className="h-4 w-4" aria-hidden />
        </ButtonLink>
      </section>
    </article>
  );
}
