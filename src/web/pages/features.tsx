import { Link, useParams } from "react-router";
import { IconArrowRight } from "@/web/components/ui/icon";
import { ButtonLink } from "@/web/components/ui/button";
import { ProductShot } from "@/web/components/product-shot";
import { AREAS, areaBySlug, type MarketingArea } from "@/shared/marketing-areas";

/** W1: a grid of the product areas, each linking to its own page. Used on the home page and /features. */
export function AreaGrid({ headingLevel = 3, exclude }: { headingLevel?: 2 | 3; exclude?: string }) {
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="area-grid">
      {AREAS.filter((a) => a.slug !== exclude).map((a) => (
        <li key={a.slug}>
          <Link to={`/features/${a.slug}`} className="group flex h-full flex-col rounded-xl border border-line bg-surface p-5 transition-colors duration-150 hover:border-fg/20 hover:bg-hover/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
            <H className="flex items-center justify-between gap-2 text-[15px] font-semibold text-fg">
              {a.name}
              <IconArrowRight className="h-4 w-4 shrink-0 text-subtle transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden />
            </H>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">{a.line}</p>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** W1: /features, every area on one page. */
export function FeaturesIndexPage() {
  return (
    <div className="mx-auto max-w-6xl px-5 pb-24 pt-32 sm:pt-40">
      <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">Everything your team works with, in one place.</h1>
      <p className="mt-4 max-w-2xl text-[17px] leading-relaxed text-muted">Mail on your own domain, with tasks, chat, docs, files, meetings, booking, contacts, invoices and signing beside it. Every area below comes with the free plan.</p>
      <div className="mt-10"><AreaGrid headingLevel={2} /></div>
      <div className="mt-12 flex flex-col gap-3 sm:flex-row">
        <ButtonLink to="/signup" size="lg">Start free <IconArrowRight className="h-4 w-4" aria-hidden /></ButtonLink>
        <ButtonLink to="/pricing" size="lg" variant="secondary">See pricing</ButtonLink>
      </div>
    </div>
  );
}

/** W1: one area's page at /features/<slug>. */
export function FeatureAreaPage({ area }: { area: MarketingArea }) {
  return (
    <div className="pb-24 pt-32 sm:pt-40" data-testid={`area-${area.slug}`}>
      <section className="mx-auto max-w-6xl px-5">
        <p className="text-sm font-medium text-brand-hover"><Link to="/features" className="hover:underline">Features</Link> <span aria-hidden className="text-subtle">/</span> {area.name}</p>
        <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">{area.headline}</h1>
        <p className="mt-4 max-w-2xl text-[17px] leading-relaxed text-muted">{area.intro}</p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <ButtonLink to="/signup" size="lg">Start free <IconArrowRight className="h-4 w-4" aria-hidden /></ButtonLink>
          <ButtonLink to="/pricing" size="lg" variant="secondary">See pricing</ButtonLink>
        </div>
        <ProductShot name={area.slug} alt={area.shotAlt} priority className="mt-12" />
      </section>
      <section className="mx-auto mt-16 max-w-6xl px-5" aria-labelledby="what-it-does">
        <h2 id="what-it-does" className="text-2xl font-semibold tracking-tight">What you can do</h2>
        <ul className="mt-6 grid gap-x-10 gap-y-7 sm:grid-cols-2 lg:grid-cols-3">
          {area.points.map((p) => (
            <li key={p.t}>
              <h3 className="text-[15px] font-semibold text-fg">{p.t}</h3>
              <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{p.b}</p>
            </li>
          ))}
        </ul>
        <p className="mt-10 text-sm text-muted">Where to find it: {area.where} Included in every workspace, the free plan too.</p>
      </section>
      <section className="mx-auto mt-20 max-w-6xl border-t border-line px-5 pt-14" aria-labelledby="more-areas">
        <h2 id="more-areas" className="text-2xl font-semibold tracking-tight">More in Multies</h2>
        <div className="mt-6"><AreaGrid exclude={area.slug} /></div>
      </section>
    </div>
  );
}

/** W1: the router's /features/:area. An unknown area shows the full list (the server already answers 404 for it). */
export function FeatureAreaRoute() {
  const { area } = useParams();
  const a = areaBySlug(area);
  return a ? <FeatureAreaPage area={a} /> : <FeaturesIndexPage />;
}
