import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Search } from "lucide-react";
import { Button, buttonClass } from "@/web/components/ui/button";
import { LOCALE } from "@/shared/locale";
import { Input } from "@/web/components/ui/input";
import { CopyButton } from "@/web/components/ui/misc";
import { fetchMailCheck, ProviderSummary, SenderChecks, SwitchPlan } from "@/web/components/mail-check";

const card = "rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6";

/** Public page: check who hosts a domain's mail and get the steps to move it to Multies. */
export function CheckPage() {
  const [params, setParams] = useSearchParams();
  const domain = (params.get("domain") ?? "").trim().toLowerCase();
  const [value, setValue] = useState(domain);
  useEffect(() => { setValue(domain); }, [domain]);
  const q = useQuery({ queryKey: ["mail-check", domain], queryFn: () => fetchMailCheck(domain), enabled: !!domain, retry: false, staleTime: 5 * 60_000 });

  function submit(e: FormEvent) {
    e.preventDefault();
    const d = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^.*@/, "");
    if (d) setParams({ domain: d });
  }

  const c = q.data;
  const shareUrl = c ? `${window.location.origin}/check?domain=${encodeURIComponent(c.domain)}` : "";
  return (
    <article className="mx-auto max-w-3xl px-5 pb-24 pt-28 sm:pt-32">
      <p className="text-xs uppercase tracking-wide text-subtle">Free tool</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Check your domain's email</h1>
      <p className="mt-3 max-w-2xl text-muted">See who hosts your mail today, whether your sender records are set, and the order of steps to move to Multies without losing a message. No sign in. We only read public DNS and store nothing.</p>

      <form onSubmit={submit} className="mt-8 flex flex-col gap-3 sm:flex-row" role="search">
        <label htmlFor="check-domain" className="sr-only">Domain or email address</label>
        <Input
          id="check-domain" value={value} onChange={(e) => setValue(e.target.value)} placeholder="yourcompany.com"
          autoCapitalize="none" autoCorrect="off" spellCheck={false} inputMode="url" autoComplete="off"
          className="h-11 sm:flex-1"
        />
        <Button type="submit" className="h-11 sm:px-6" loading={q.isFetching}><Search className="h-4 w-4" aria-hidden />Check</Button>
      </form>

      <div aria-live="polite" className="mt-8">
        {q.isFetching && !c && (
          <div className="space-y-4" aria-busy="true">
            <div className="h-[92px] rounded-2xl bg-fill/70" />
            <div className="h-[180px] rounded-2xl bg-fill/60" />
          </div>
        )}
        {q.error && !q.isFetching && <p role="alert" className="rounded-xl border border-bad/20 bg-bad-soft px-4 py-3 text-[14px] text-bad">{(q.error as Error).message}</p>}
        {c && (
          <div className="space-y-5">
            <section className={card} aria-labelledby="c-host">
              <h2 id="c-host" className="sr-only">Mail host</h2>
              <ProviderSummary check={c} />
            </section>
            <section className={card} aria-labelledby="c-records">
              <h2 id="c-records" className="text-lg font-semibold">Sender records</h2>
              <p className="mt-1 text-[14px] text-muted">These decide whether your mail lands in the inbox or in spam, wherever it is hosted.</p>
              <div className="mt-2"><SenderChecks check={c} /></div>
            </section>
            <section className={card} aria-labelledby="c-plan">
              <h2 id="c-plan" className="text-lg font-semibold">{c.provider.kind === "multies" ? "Status" : "Your switch plan"}</h2>
              {c.provider.kind !== "multies" && <p className="mt-1 text-[14px] text-muted">In this order, nothing bounces and nobody loses mail.</p>}
              <SwitchPlan check={c} className="mt-5" />
              {c.provider.kind !== "multies" && (
                <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-5">
                  <Link to="/signup" className={buttonClass("primary", "md")}>Start free with {c.domain}<ArrowRight className="h-4 w-4" aria-hidden /></Link>
                  <span className="text-[13px] text-subtle">One domain and three mailboxes free, no card.</span>
                </div>
              )}
            </section>
            <div className="flex flex-wrap items-center justify-between gap-3 text-[13px] text-subtle">
              <span>Checked {new Date(c.checkedAt).toLocaleString(LOCALE)}</span>
              <CopyButton value={shareUrl} label="Copy link to this check" />
            </div>
          </div>
        )}
      </div>
    </article>
  );
}
