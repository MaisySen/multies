import { ArrowRight, AtSign, BadgeCheck, Cloud, FileClock, Inbox, KeyRound, ShieldCheck, Sparkles } from "lucide-react";
import { Button, ButtonLink } from "@/web/components/ui/button";
import { HeroVisual } from "@/web/components/hero-visual";
import { PlanCards } from "@/web/components/plan-cards";
import { useConfig } from "@/web/lib/queries";
import { useStartDemo } from "@/web/lib/demo";

const features = [
  {
    icon: BadgeCheck, title: "DNS that explains itself",
    body: "We check MX, SPF, DKIM and DMARC live against the internet and tell you exactly what to fix, down to merging the SPF record you already have.",
    wide: true,
  },
  { icon: KeyRound, title: "A signing key per domain", body: "Every domain gets its own 2048-bit DKIM key, encrypted at rest. Nobody else signs as you." },
  { icon: AtSign, title: "Mailboxes and aliases", body: "Real inboxes for people, forwarding aliases for roles. sales@ can reach three founders and a Gmail." },
  { icon: Inbox, title: "Webmail that's fast", body: "Threads, search, folders, drafts and keyboard shortcuts. Opens instantly, works on your phone." },
  { icon: Cloud, title: "Built on Cloudflare Email Routing", body: "Inbound mail rides Cloudflare's global network into a signed webhook. No servers to babysit.", wide: true },
  { icon: FileClock, title: "Every delivery, logged", body: "Inbound, outbound and forwarded mail with status and reason, plus an audit trail of every change." },
];

const faqs = [
  { q: "Do I need to move my domain?", a: "No. Keep your domain wherever it's registered. You add a few DNS records. We show you each one, check them live, and tell you when everything's right." },
  { q: "How does inbound mail reach MyMail?", a: "Your MX records point at Cloudflare Email Routing. A small Email Worker (we give you the code) signs each message and hands it to MyMail, which files it in the right mailbox, alias or catch-all." },
  { q: "Can I send mail too?", a: "Yes. Outbound mail goes through a transactional email provider with your domain's SPF, DKIM and DMARC in place, so it lands in inboxes rather than spam." },
  { q: "What happens if I already use Google Workspace?", a: "We'll spot your existing MX and SPF records and show you exactly what to change, including a merged SPF record, so nothing breaks during the move." },
  { q: "Is my mail private?", a: "Workspaces are fully isolated, sessions are server-side, passwords are hashed, and signing keys and webhook secrets are encrypted at rest. Every admin action is in your audit log." },
];

export function Landing() {
  const config = useConfig();
  const demo = useStartDemo();
  const demoEnabled = config.data?.demoEnabled;

  return (
    <>
      <section className="relative overflow-hidden pt-32 sm:pt-40">
        <div className="grid-bg pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_top,black_30%,transparent_70%)]" aria-hidden />
        <div className="relative mx-auto max-w-6xl px-5 text-center">
          <a href="#how" className="inline-flex items-center gap-2 rounded-full border border-line-strong bg-white/[0.03] py-1 pl-1.5 pr-3 text-[12.5px] text-muted transition-colors hover:text-fg">
            <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand-hover">New</span>
            Inbound via Cloudflare Email Routing <ArrowRight className="h-3 w-3" />
          </a>
          <h1 className="text-gradient mx-auto mt-7 max-w-4xl text-[42px] font-semibold leading-[1.05] tracking-[-0.035em] sm:text-6xl md:text-7xl">
            Email on your own domain. Verified in minutes.
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-[17px] leading-relaxed text-muted">
            Add your domain, follow DNS steps that check themselves, and create mailboxes for your team. Professional email without the enterprise suite.
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <ButtonLink to="/signup" size="lg" className="w-full sm:w-auto">Start free <ArrowRight className="h-4 w-4" /></ButtonLink>
            {demoEnabled && (
              <Button size="lg" variant="secondary" onClick={demo.start} loading={demo.loading} className="w-full sm:w-auto">
                <Sparkles className="h-4 w-4" /> Try the live demo
              </Button>
            )}
          </div>
          <p className="mt-4 text-xs text-subtle">Free for one domain. No credit card.</p>
        </div>
        <div className="relative mt-16 px-5 pb-16 sm:mt-20">
          <HeroVisual />
        </div>
      </section>

      <section className="border-y border-line bg-surface/50">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-10 gap-y-3 px-5 py-6 text-sm text-subtle">
          <span>Works with DNS at</span>
          {["Cloudflare", "Namecheap", "GoDaddy", "Porkbun", "Squarespace", "Route 53"].map((n) => (
            <span key={n} className="font-medium text-muted">{n}</span>
          ))}
        </div>
      </section>

      <section id="features" className="mx-auto max-w-6xl scroll-mt-20 px-5 py-24 sm:py-32">
        <div className="max-w-2xl">
          <p className="text-sm font-medium text-brand-hover">Everything email needs</p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">The boring parts, done right.</h2>
          <p className="mt-4 text-muted">Deliverability lives and dies on DNS. MyMail makes it visible, verifiable and fixable, then gets out of your way.</p>
        </div>
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {features.map(({ icon: Icon, title, body, wide }) => (
            <div key={title} className={`group relative overflow-hidden rounded-2xl border border-line bg-surface p-6 transition-colors hover:border-line-strong ${wide ? "md:col-span-2" : ""}`}>
              <div className="absolute -right-16 -top-16 h-40 w-40 rounded-full bg-brand/0 blur-3xl transition-colors duration-500 group-hover:bg-brand/15" aria-hidden />
              <div className="grid h-10 w-10 place-items-center rounded-lg border border-line-strong bg-elevated text-brand-hover"><Icon className="h-5 w-5" /></div>
              <h3 className="mt-5 text-[15px] font-semibold">{title}</h3>
              <p className="mt-2 max-w-md text-sm leading-relaxed text-muted">{body}</p>
              {title.startsWith("DNS") && <DnsSnippet />}
            </div>
          ))}
        </div>
      </section>

      <section id="how" className="scroll-mt-20 border-y border-line bg-surface/40">
        <div className="mx-auto max-w-6xl px-5 py-24 sm:py-32">
          <p className="text-sm font-medium text-brand-hover">How it works</p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Three steps. About five minutes.</h2>
          <ol className="mt-12 grid gap-4 md:grid-cols-3">
            {[
              { n: "01", t: "Add your domain", b: "We generate its DKIM key and the exact records to publish: host, type and value, ready to copy." },
              { n: "02", t: "Publish and verify", b: "Paste the records at your DNS provider. MyMail checks them live and turns each one green as it propagates." },
              { n: "03", t: "Create mailboxes", b: "Add people and aliases, connect inbound routing, and start reading and sending from your own domain." },
            ].map((s) => (
              <li key={s.n} className="rounded-2xl border border-line bg-bg/60 p-6">
                <span className="font-mono text-xs text-brand-hover">{s.n}</span>
                <h3 className="mt-3 text-[15px] font-semibold">{s.t}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{s.b}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-24 sm:py-32">
        <div className="mb-12 text-center">
          <p className="text-sm font-medium text-brand-hover">Pricing</p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Simple plans that grow with you.</h2>
          <p className="mt-4 text-muted">Start free on one domain. Upgrade when your team does.</p>
        </div>
        <PlanCards />
      </section>

      <section id="faq" className="scroll-mt-20 border-t border-line">
        <div className="mx-auto grid max-w-6xl gap-12 px-5 py-24 md:grid-cols-[1fr_1.4fr] sm:py-32">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight">Questions, answered.</h2>
            <p className="mt-4 text-muted">The things people ask before they point their MX records at us.</p>
          </div>
          <div className="divide-y divide-line border-y border-line">
            {faqs.map((f) => (
              <details key={f.q} className="group py-5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[15px] font-medium [&::-webkit-details-marker]:hidden">
                  {f.q}
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-line text-muted transition-transform group-open:rotate-45" aria-hidden>+</span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-muted">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="px-5 pb-24">
        <div className="relative mx-auto max-w-6xl overflow-hidden rounded-3xl border border-line-strong bg-gradient-to-br from-brand/25 via-surface to-surface px-6 py-16 text-center sm:px-12">
          <ShieldCheck className="mx-auto h-8 w-8 text-brand-hover" />
          <h2 className="mx-auto mt-5 max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">Your domain deserves better than a forwarding hack.</h2>
          <p className="mx-auto mt-4 max-w-lg text-muted">Set up real email on it today. It's free for your first domain.</p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <ButtonLink to="/signup" size="lg">Create your account</ButtonLink>
            {demoEnabled && <Button size="lg" variant="secondary" onClick={demo.start} loading={demo.loading}>Explore the demo</Button>}
          </div>
        </div>
      </section>
    </>
  );
}

function DnsSnippet() {
  const lines = [
    { t: "MX", h: "@", v: "route1.mx.cloudflare.net", s: "ok" },
    { t: "TXT", h: "@", v: "v=spf1 include:_spf.mx.cloudflare.net ~all", s: "ok" },
    { t: "TXT", h: "mymail._domainkey", v: "v=DKIM1; k=rsa; p=MIIBIjANBgkq…", s: "ok" },
    { t: "TXT", h: "_dmarc", v: "v=DMARC1; p=quarantine; rua=mailto:…", s: "warn" },
  ];
  return (
    <div className="mt-6 overflow-hidden rounded-xl border border-line bg-bg/80 font-mono text-[11.5px]" aria-hidden>
      {lines.map((l) => (
        <div key={l.h + l.t} className="flex items-center gap-3 border-b border-line/70 px-3 py-2 last:border-0">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${l.s === "ok" ? "bg-ok" : "bg-warn"}`} />
          <span className="w-8 shrink-0 text-subtle">{l.t}</span>
          <span className="w-32 shrink-0 truncate text-muted max-sm:hidden">{l.h}</span>
          <span className="truncate text-fg/80">{l.v}</span>
        </div>
      ))}
    </div>
  );
}
