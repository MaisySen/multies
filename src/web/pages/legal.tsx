import { useEffect } from "react";
import { Link, useParams } from "react-router";
import { LEGAL_DOCS, LEGAL_EFFECTIVE, type Block, type LegalSlug } from "@/shared/legal";
import { NotFound } from "./not-found";

function Body({ block }: { block: Block }) {
  if (typeof block === "string") return <p>{block}</p>;
  if ("list" in block) return <ul className="list-disc space-y-1.5 pl-5">{block.list.map((li) => <li key={li}>{li}</li>)}</ul>;
  const [head, ...rows] = block.table;
  return (
    <div tabIndex={0} role="region" aria-label={`Table: ${head!.join(", ")}`} className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full text-left text-[13px]">
        <thead className="bg-fill/60 text-fg"><tr>{head!.map((h) => <th key={h} scope="col" className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-line">{rows.map((r) => <tr key={r[0]}>{r.map((c, i) => <td key={i} className="px-3 py-2 align-top">{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

/** Privacy policy, terms, acceptable use and the DPA: one template, content in src/shared/legal.ts. */
export function LegalPage({ slug: fixed }: { slug?: LegalSlug }) {
  const params = useParams();
  const slug = (fixed ?? params.slug) as LegalSlug;
  const doc = LEGAL_DOCS[slug];
  useEffect(() => { if (doc) document.title = `${doc.title} | Multies`; }, [doc]);
  if (!doc) return <NotFound embedded />;
  return (
    <article className="mx-auto max-w-3xl px-5 pb-24 pt-28">
      <p className="text-xs uppercase tracking-wide text-subtle">Legal</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">{doc.title}</h1>
      <p className="mt-2 text-muted">{doc.summary}</p>
      <p className="mt-1 text-xs text-subtle">Effective {LEGAL_EFFECTIVE}. Governed by the laws of New South Wales, Australia.</p>
      <nav aria-label="On this page" className="mt-8 rounded-lg border border-line p-4 text-sm">
        <ol className="grid gap-1.5 sm:grid-cols-2">
          {doc.sections.map((s, i) => <li key={s.id}><a href={`#${s.id}`} className="text-muted hover:text-fg">{i + 1}. {s.title}</a></li>)}
        </ol>
      </nav>
      <div className="mt-10 space-y-10">
        {doc.sections.map((s, i) => (
          <section key={s.id} id={s.id} aria-labelledby={`${s.id}-h`} className="scroll-mt-24">
            <h2 id={`${s.id}-h`} className="text-lg font-semibold">{i + 1}. {s.title}</h2>
            <div className="mt-3 space-y-3 text-[14.5px] leading-relaxed text-muted">{s.body.map((b, j) => <Body key={j} block={b} />)}</div>
          </section>
        ))}
      </div>
      <p className="mt-14 border-t border-line pt-6 text-sm text-subtle">
        See also <Link to="/privacy" className="hover:text-fg hover:underline">Privacy</Link>, <Link to="/terms" className="hover:text-fg hover:underline">Terms</Link>, <Link to="/acceptable-use" className="hover:text-fg hover:underline">Acceptable use</Link> and the <Link to="/dpa" className="hover:text-fg hover:underline">Data processing agreement</Link>.
      </p>
    </article>
  );
}
