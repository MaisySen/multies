import { Link } from "react-router";
import { WHATS_NEW, formatWhatsNewDate } from "@/shared/whats-new";
import { LOCALE } from "@/shared/locale";

/** R53 (MB-133): the public changelog. The same list the account menu's What's new item points to. */
export function ChangelogPage() {
  return (
    <section className="mx-auto max-w-3xl px-5 pb-24 pt-32 sm:pt-36">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">What's new</h1>
      <p className="mt-3 text-muted">What changed in Multies, newest first.</p>
      <ol className="mt-8 divide-y divide-line border-y border-line">
        {WHATS_NEW.map((e) => (
          <li key={e.id} id={e.id} className="grid gap-1.5 py-6 sm:grid-cols-[8.5rem_1fr] sm:gap-6" data-testid="changelog-entry">
            <time dateTime={e.date} className="text-sm tabular-nums text-subtle sm:pt-0.5">{formatWhatsNewDate(e.date, LOCALE)}</time>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold tracking-tight">{e.title}</h2>
              <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{e.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-6 text-sm text-muted">Something not working? The <Link to="/status" className="text-brand-hover hover:underline">system status</Link> page shows live checks, and <Link to="/support" className="text-brand-hover hover:underline">support</Link> is a message away.</p>
    </section>
  );
}
