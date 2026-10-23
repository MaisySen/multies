import { ArrowRight, Sparkles } from "lucide-react";
import { Button, ButtonLink } from "@/web/components/ui/button";
import { HeroVisual } from "@/web/components/hero-visual";
import { PlanCards } from "@/web/components/plan-cards";
import { useConfig } from "@/web/lib/queries";
import { useStartDemo } from "@/web/lib/demo";

const features = [
  { title: "Mailboxes and aliases", body: "Real inboxes for people, forwarding aliases for roles. sales@ can reach three founders and a Gmail." },
  { title: "A signing key per domain", body: "Every domain gets its own 2048-bit DKIM key, encrypted at rest. Nobody else signs as you." },
  { title: "Webmail, plus your own apps", body: "Threads, search and keyboard shortcuts in the browser. App passwords for Outlook, Apple Mail and Thunderbird over IMAP." },
  { title: "Bounces handled for you", body: "Hard bounces and spam complaints go on a suppression list, so one bad address can't drag down your reputation." },
  { title: "DMARC reports, read", body: "Gmail, Yahoo and Microsoft send daily reports. We parse them and show every server sending as your domain." },
  { title: "An API and webhooks", body: "A REST API with an OpenAPI spec, and signed webhooks for received, sent and bounced mail." },
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
        <div className="relative mx-auto max-w-6xl px-5 text-center">
          <h1 className="mx-auto text-fg max-w-4xl text-[42px] font-semibold leading-[1.05] tracking-[-0.035em] sm:text-6xl md:text-7xl">
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
        <div className="grid gap-12 lg:grid-cols-[1fr_1.15fr] lg:gap-16">
          <div className="min-w-0">
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">DNS you can see, not guess at.</h2>
            <p className="mt-4 max-w-md text-muted">Whether mail lands is decided by four DNS records. MyMail checks each one live, says what's wrong in plain words, and merges the SPF record you already have instead of breaking it.</p>
            <DnsSnippet />
          </div>
          <dl className="grid content-start gap-x-10 sm:grid-cols-2">
            {features.map(({ title, body }) => (
              <div key={title} className="border-t border-line py-6">
                <dt className="text-[15px] font-semibold">{title}</dt>
                <dd className="mt-2 text-sm leading-relaxed text-muted">{body}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section id="how" className="scroll-mt-20 border-y border-line bg-surface/40">
        <div className="mx-auto max-w-6xl px-5 py-20 sm:py-24">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Set up in about five minutes</h2>
          <ol className="mt-10 grid gap-8 md:grid-cols-3 md:gap-10">
            {[
              { t: "Add your domain", b: "We generate its DKIM key and the exact records to publish: host, type and value, ready to copy." },
              { t: "Publish the records", b: "Paste them at your DNS provider. Each one turns green as it propagates, usually within minutes." },
              { t: "Create mailboxes", b: "Add people and aliases, connect inbound routing, and start reading and sending from your own domain." },
            ].map((step, i) => (
              <li key={step.t} className="flex gap-4">
                <span className="mt-0.5 font-mono text-sm tabular-nums text-subtle" aria-hidden>{i + 1}.</span>
                <div>
                  <h3 className="text-[15px] font-semibold">{step.t}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted">{step.b}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-24 sm:py-32">
        <div className="mb-12 text-center">
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
        <div className="mx-auto max-w-6xl border-t border-line pt-20 text-center">
          <h2 className="mx-auto max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">Your domain deserves better than a forwarding hack.</h2>
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
    <div className="mt-8 overflow-hidden rounded-xl border border-line bg-surface font-mono text-[11.5px]" aria-hidden>
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
