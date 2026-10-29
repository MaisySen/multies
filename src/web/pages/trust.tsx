import { useEffect } from "react";
import { Link } from "react-router";
import { IconActivity, IconDatabase, IconDatabaseBackup, IconKey, IconLock, IconMail, IconShieldCheck, IconTeam, type IconComponent } from "@/web/components/ui/icon";
import {
  BACKUPS, DATA_REGION, ENCRYPTION, INCIDENTS, SECURITY_EMAIL, SIGN_IN, SUBPROCESSORS, TRUST_UPDATED, type TrustFact,
} from "@/shared/trust";
import { LegalLine } from "@/web/components/legal-line";

const card = "rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6";

function Section({ id, icon: Icon, title, intro, children }: { id: string; icon: IconComponent; title: string; intro?: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className={`${card} scroll-mt-24`}>
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand" aria-hidden><Icon className="h-[18px] w-[18px]" /></span>
        <div className="min-w-0">
          <h2 id={`${id}-h`} className="text-[17px] font-semibold tracking-tight">{title}</h2>
          {intro && <p className="mt-1 text-sm text-muted">{intro}</p>}
        </div>
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Facts({ items }: { items: TrustFact[] }) {
  return (
    <dl className="divide-y divide-line">
      {items.map((f) => (
        <div key={f.label} className="grid gap-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[160px_1fr] sm:gap-4">
          <dt className="text-[13px] font-medium text-fg">{f.label}</dt>
          <dd className="text-[14px] leading-relaxed text-muted">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

const NAV = [
  ["region", "Data region"], ["subprocessors", "Sub processors"], ["backups", "Backups"], ["sign-in", "Sign in"],
  ["encryption", "Encryption"], ["incidents", "Incident history"], ["contact", "Report a problem"],
] as const;

/** Public page: the answers a security review asks for, each one read from how Multies is actually built. */
export function TrustPage() {
  useEffect(() => { if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView(); }, []);
  return (
    <article className="mx-auto max-w-3xl px-5 pb-24 pt-28 sm:pt-32">
      <p className="text-xs uppercase tracking-wide text-subtle">Trust</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Security and data at Multies</h1>
      <p className="mt-3 max-w-2xl text-muted">Where your data lives, who helps us run the service, how it is protected and backed up, and what has gone wrong. Every line here describes how Multies works today.</p>
      <p className="mt-2 text-sm text-muted"><LegalLine /></p>
      <p className="mt-2 text-xs text-subtle">Last updated {TRUST_UPDATED}</p>

      <nav aria-label="On this page" className="mt-8 flex flex-wrap gap-2">
        {NAV.map(([id, label]) => (
          <a key={id} href={`#${id}`} className="rounded-full border border-line px-3 py-1.5 text-[13px] text-muted transition-colors hover:border-line-strong hover:text-fg">{label}</a>
        ))}
      </nav>

      <div className="mt-8 space-y-5">
        <Section id="region" icon={IconDatabase} title="Data region"><Facts items={DATA_REGION} /></Section>

        <Section id="subprocessors" icon={IconTeam} title="Sub processors" intro="Only the services Multies actually calls, named by what they do. Optional ones run only when you use that feature. Our Data processing agreement names each one.">
          <ul className="divide-y divide-line">
            {SUBPROCESSORS.map((s) => (
              <li key={s.name} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[14px] font-medium">{s.name}</span>
                  {s.when === "optional" && <span className="rounded-full bg-fill px-2 py-0.5 text-[11px] font-medium text-muted">Optional</span>}
                  <span className="ml-auto text-[12px] text-subtle">{s.where}</span>
                </div>
                <p className="mt-1 text-[13.5px] text-muted">{s.purpose}</p>
                <p className="mt-0.5 text-[12.5px] text-subtle">Data: {s.data}</p>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-[13px] text-subtle">The <Link to="/dpa" className="text-brand-hover hover:underline">data processing agreement</Link> sets out how we add or change sub processors.</p>
        </Section>

        <Section id="backups" icon={IconDatabaseBackup} title="Backups"><Facts items={BACKUPS} /></Section>
        <Section id="sign-in" icon={IconKey} title="Sign in"><Facts items={SIGN_IN} /></Section>
        <Section id="encryption" icon={IconLock} title="Encryption"><Facts items={ENCRYPTION} /></Section>

        <Section id="incidents" icon={IconActivity} title="Incident history" intro="Anything that stopped people from using Multies, newest first.">
          {INCIDENTS.length === 0 ? <p className="text-sm text-muted">No incidents so far.</p> : (
            <ol className="space-y-4">
              {INCIDENTS.map((i) => (
                <li key={i.date + i.title} className="rounded-xl bg-fill/60 p-4">
                  <p className="text-[12px] text-subtle"><time>{i.date}</time></p>
                  <p className="mt-0.5 text-[14px] font-medium">{i.title}</p>
                  <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">{i.impact}</p>
                  <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted"><span className="font-medium text-fg">What changed: </span>{i.fix}</p>
                </li>
              ))}
            </ol>
          )}
          <p className="mt-4 text-[13px] text-subtle">Live status is on the <Link to="/status" className="text-brand-hover hover:underline">system status</Link> page.</p>
        </Section>

        <Section id="contact" icon={IconShieldCheck} title="Report a problem" intro="Found a vulnerability or a privacy issue? Tell us and we will reply.">
          <a href={`mailto:${SECURITY_EMAIL}`} className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-brand-fg transition-colors hover:bg-brand/90">
            <IconMail className="h-4 w-4" aria-hidden />{SECURITY_EMAIL}
          </a>
          <p className="mt-4 text-[13px] text-subtle">
            Machine readable: <a href="/.well-known/security.txt" className="text-brand-hover hover:underline">security.txt</a>. How we handle personal information: <Link to="/privacy" className="text-brand-hover hover:underline">privacy policy</Link>.
          </p>
        </Section>
      </div>
    </article>
  );
}
