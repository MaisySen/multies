import { Link, useParams } from "react-router";
import { IconArrowRight, IconCheck, IconDownload, IconFileUp } from "@/web/components/ui/icon";
import { ButtonLink, buttonClass } from "@/web/components/ui/button";
import { useSignedIn } from "@/web/lib/queries";
import { SWITCH_SOURCES, sampleFileName, startImportHref, switchSource, type SwitchSource } from "@/shared/switch-sources";
import { NotFound } from "./not-found";
import { LESS_ADMIN } from "@/shared/residency";

const card = "rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6";

/** R58 (MB-237): /switch, the list of tools the import reads. */
export function SwitchIndexPage() {
  return (
    <article className="mx-auto max-w-3xl px-5 pb-24 pt-28 sm:pt-32" data-testid="switch-index">
      <p className="text-xs uppercase tracking-wide text-subtle">Move to Multies</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Bring your work over</h1>
      <p className="mt-3 max-w-2xl text-muted">Export from the tool you use now and upload the file. You check the columns, people and statuses, see the first rows before anything is made, and can undo the whole import.</p>
      <ul className="mt-8 grid gap-3 sm:grid-cols-2">
        {SWITCH_SOURCES.map((s) => (
          <li key={s.slug}>
            <Link to={`/switch/${s.slug}`} className={`${card} flex min-h-[72px] items-center justify-between gap-3 transition-shadow duration-150 hover:shadow-[0_4px_14px_rgb(0_0_0/0.08)] motion-reduce:transition-none`} data-testid={`switch-link-${s.slug}`}>
              <span><span className="block font-semibold">{s.label}</span><span className="block text-[13px] text-muted">Upload {s.file}</span></span>
              <IconArrowRight className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-8 text-sm text-muted">Using a spreadsheet? Any CSV or Excel file with a title column works too, from the same import screen.</p>

      {/* R60 (trust): what Multies takes over, honestly scoped (src/shared/residency.ts). */}
      <section className={`${card} mt-10`} aria-labelledby="sw-less-admin" data-testid="switch-less-admin">
        <h2 id="sw-less-admin" className="text-lg font-semibold">Less admin, not more</h2>
        <ul className="mt-3 space-y-3">
          {LESS_ADMIN.map((s) => (
            <li key={s.title} className="flex gap-2.5 text-[15px]"><IconCheck className="mt-1 h-4 w-4 shrink-0 text-ok" aria-hidden /><span><span className="font-medium">{s.title}. </span><span className="text-muted">{s.body}</span></span></li>
          ))}
        </ul>
        <p className="mt-4 text-[13px] text-subtle">What connects today and what is planned: <Link to="/trust#connections" className="text-brand-hover hover:underline">Connections</Link>. Want to look first? <Link to="/trust#try" className="text-brand-hover hover:underline">Try it without a client mailbox</Link>.</p>
      </section>
    </article>
  );
}

/** R58 (MB-237): /switch/<tool>, what moves over, the steps, a sample file and the button into the real import. */
export function SwitchPage({ source: fixed }: { source?: string } = {}) {
  // WEB1: the build passes the tool, so the served HTML carries the page (and its h1) before scripts run.
  const params = useParams();
  const source = fixed ?? params.source;
  const s = switchSource(source);
  if (!s) return <NotFound embedded />;
  return <SwitchSourcePage s={s} />;
}

function SwitchSourcePage({ s }: { s: SwitchSource }) {
  const signedIn = useSignedIn();
  const href = startImportHref(s.slug, signedIn);
  const cta = signedIn ? `Import from ${s.label}` : `Sign up and import from ${s.label}`;
  return (
    <article className="mx-auto max-w-3xl px-5 pb-24 pt-28 sm:pt-32" data-testid={`switch-page-${s.slug}`}>
      <p className="text-xs uppercase tracking-wide text-subtle"><Link to="/switch" className="hover:text-fg">Move to Multies</Link></p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Bring your {s.label} work into Multies</h1>
      <p className="mt-3 max-w-2xl text-muted">Export {s.file} from {s.label} and upload it. You check the columns and people, see a preview before anything is made, and can undo the whole import later.</p>
      <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center">
        <ButtonLink to={href} size="lg" className="max-sm:w-full" data-hero-cta data-testid="switch-start">{cta}<IconArrowRight className="h-4 w-4" aria-hidden /></ButtonLink>
        <a href={s.sample} download={sampleFileName(s)} className={buttonClass("secondary", "lg", "max-sm:w-full")} data-testid="switch-sample"><IconDownload className="h-4 w-4" aria-hidden />Download a sample file</a>
      </div>

      <section className={`${card} mt-10`} aria-labelledby="sw-moves">
        <h2 id="sw-moves" className="text-lg font-semibold">What moves over</h2>
        <ul className="mt-3 space-y-2.5">
          {s.moves.map((m) => <li key={m} className="flex gap-2.5 text-[15px]"><IconCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden />{m}</li>)}
        </ul>
        <p className="mt-4 text-[13px] text-subtle">People are matched by email address. Anyone not in your workspace yet can be left unassigned or given to someone else.</p>
      </section>

      <section className="mt-10" aria-labelledby="sw-steps">
        <h2 id="sw-steps" className="text-lg font-semibold">How to move</h2>
        <ol className="mt-4 space-y-3">
          {s.steps.map((step, i) => (
            <li key={step} className="flex gap-3 text-[15px]">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-fill text-[12px] font-semibold tabular-nums" aria-hidden>{i + 1}</span>
              <span className="pt-0.5">{step}</span>
            </li>
          ))}
          <li className="flex gap-3 text-[15px]">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand text-[12px] font-semibold text-white" aria-hidden><IconFileUp className="h-3.5 w-3.5" /></span>
            <span className="pt-0.5">In Multies, open Settings, then Import and export, pick {s.label} and upload the file. The button above takes you straight there.</span>
          </li>
        </ol>
      </section>

      <section className={`${card} mt-10`} aria-labelledby="sw-sample">
        <h2 id="sw-sample" className="text-lg font-semibold">Try it with the sample first</h2>
        <p className="mt-2 text-[15px] text-muted">The sample is a small made up export in the same shape as a real one. Upload it to see how your work will look, then undo it and bring in your own.</p>
        <a href={s.sample} download={sampleFileName(s)} className="mt-3 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-brand-hover hover:underline sm:min-h-0"><IconDownload className="h-4 w-4" aria-hidden />{sampleFileName(s)}</a>
      </section>

      <section className="mt-12 text-center" aria-labelledby="sw-start">
        <h2 id="sw-start" className="text-2xl font-semibold tracking-tight">Ready when you are</h2>
        <p className="mx-auto mt-2 max-w-xl text-muted">Small teams use Multies for free. <Link to="/startups" className="font-medium text-brand-hover hover:underline">See what Free includes</Link></p>
        <ButtonLink to={href} size="lg" className="mt-6 max-sm:w-full">{cta}<IconArrowRight className="h-4 w-4" aria-hidden /></ButtonLink>
      </section>
    </article>
  );
}
