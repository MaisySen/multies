import { Link } from "react-router";
import { IconArrowRight, IconCheck, IconPlay } from "@/web/components/ui/icon";
import { Button, ButtonLink } from "@/web/components/ui/button";
import { ProductShot } from "@/web/components/product-shot";
import { PlanCards } from "@/web/components/plan-cards";
import { AreaGrid } from "@/web/pages/features";
import { useConfig } from "@/web/lib/queries";
import { useStartDemo } from "@/web/lib/demo";
import { DemoPausedNote } from "@/web/components/demo-paused";
import { RESIDENCY_ANSWER } from "@/shared/residency";
import { OFFER_COPY } from "@/shared/offers";
import { GetTheApp } from "@/web/components/get-the-app";

/**
 * W1 (owner, Nov 1: "website is missing a lot"): the home page tells the whole story, one workspace for the team,
 * with mail on your own domain at its heart. Only live features. Shots are the real app (sample workspace).
 */
const deeper: { id: string; kicker: string; title: string; body: string; shot?: { name: string; alt: string }; points: string[]; more: string }[] = [
  {
    id: "mail", kicker: "Mail", title: "Email on the domain you already own.",
    body: "Real mailboxes for people and aliases for roles, a shared team inbox, and every DNS record checked live, so your mail lands in inboxes.",
    points: [
      "Keep your domain where it is registered. Add a few records, and we check each one live.",
      "Every domain gets its own DKIM key, bounce handling and DMARC reports.",
      "A shared inbox with assignments and private notes, or helpdesk tickets with a chat box for your website.",
      "Newsletters, mail archive and secure sending from your own address.",
    ],
    more: "/features/mail",
  },
  {
    id: "work", kicker: "Work", title: "Turn email into work, without another app.",
    body: "One click turns a thread into a task. Plan it on a board, a list, a calendar or a timeline, talk it through in chat, and write it up in a doc.",
    shot: { name: "tasks", alt: "A Multies project board with task cards in columns." },
    points: [
      "Boards, lists, calendar and timeline, with custom fields, goals and templates.",
      "My Day time blocking and time tracking per person and project.",
      "Docs with diagrams, whiteboards and comments, and team chat beside them.",
      "Automations and dashboards that keep everyone up to date.",
    ],
    more: "/features/tasks",
  },
  {
    id: "business", kicker: "Business", title: "Run the business side in the same place.",
    body: "Quote and invoice the client you just emailed, let people book a time or a room, and send the contract to sign, without copying anything between apps.",
    shot: { name: "invoices", alt: "A Multies invoice with line items and GST." },
    points: [
      "Quotes and Australian tax invoices with GST, a link to pay and part payments.",
      "Booking pages, rooms and desks, time polls and events with tickets.",
      "Contacts that build themselves, with a timeline, a deal pipeline and client portals.",
      "Signing with an email code and a sealed record, and forms with file uploads, signatures, pages and show or hide logic.",
    ],
    more: "/features/invoices",
  },
  {
    id: "agents", kicker: "AI agents", title: "AI agents that help, with a person approving.",
    body: "Give an agent its own inbox on your domain with one API call. By default, everything an agent writes waits for a person to approve it.",
    shot: { name: "agents", alt: "The Multies approvals screen with a message an agent wrote, waiting for a person." },
    points: [
      "Agent inboxes that read mail as clean JSON and reply in the thread.",
      "Daily caps, allowed recipients and an audit log of every action.",
      "Bring your own AI: connect any AI app or agent through MCP, free.",
      "Ask a question across your workspace and get an answer that cites only what you can open.",
    ],
    more: "/features/agents",
  },
];

const steps = [
  { t: "Add your domain", b: "Keep it where it is registered. We read what is there now and show you what to change." },
  { t: "Add the records we show you", b: "Each DNS record is checked live, so you know the moment everything is right." },
  { t: "Invite your team", b: "Three people and three mailboxes are free. Guests and clients are always free." },
  { t: "Bring your agents, if you like", b: "Create an agent inbox or connect your AI through MCP. A person approves what it sends." },
];

const faqs = [
  { q: "Is it really free?", a: "Yes. One domain, three mailboxes, 3 GB, three agent inboxes, for as long as you like, with no card. Add-ons cost A$1 to A$3 a month each, for the whole business, never per person. Pay yearly and get two months free, or use the code LAUNCH30 for 30 percent off your first 3 months of monthly billing." },
  // R62: from src/shared/offers.ts, the same words as the pricing page.
  { q: "Do you reward referrals?", a: OFFER_COPY.referral },
  { q: "Are tasks, docs, booking and invoices extra?", a: "No. Tasks, chat, docs, files, meetings, booking, contacts, invoices, signing and social come with every workspace, the free plan too. Add-ons only raise limits like mailboxes and storage." },
  { q: "What does the AI cost?", a: "Nothing from us. Bring your own AI: connect any AI app or agent through MCP, free. Multies never resells AI or meters it." },
  { q: "Can an agent send email without me?", a: "Only if you let it. New agents need a person to approve every message. You can relax that to only mail leaving Multies, or turn it off, and set a daily cap and a list of who it may write to." },
  { q: "Do I need to move my domain?", a: "No. Keep your domain wherever it's registered. You add a few DNS records. We show you each one, check them live, and tell you when everything's right." },
  { q: "I already have email somewhere else. Can I switch?", a: "Yes. We spot your existing mail records and show you exactly what to change, including a merged SPF record, so nothing breaks during the move. You can bring your tasks over from the tool you use now too." },
  { q: "Where is my email stored?", a: RESIDENCY_ANSWER },
  { q: "Can I try it without connecting a client mailbox?", a: "Yes. Open the live demo, a sample workspace with made up mail and no sign up, deleted after 24 hours. Or take a free test address like yourname@mail.multies.si. Connect a real mailbox only when you are ready; removing it deletes our copy." },
  { q: "Is my email private?", a: "Workspaces are fully isolated, sessions are server side, passwords are hashed, and signing keys and webhook secrets are encrypted at rest. Every admin action is in your audit log." },
];

export function Landing() {
  const config = useConfig();
  const demo = useStartDemo();
  const demoEnabled = config.data?.demoEnabled;

  return (
    <>
      <section className="relative overflow-hidden pt-32 sm:pt-40">
        <div className="relative mx-auto max-w-6xl px-5 text-center">
          <h1 className="mx-auto max-w-4xl text-[40px] font-semibold leading-[1.05] tracking-[-0.035em] text-fg sm:text-5xl md:text-6xl">
            One workspace for your team.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-[17px] leading-relaxed text-muted">
            Mail on your own domain, with tasks, chat, docs, files, meetings, booking, contacts, invoices and signing in the same place. AI agents help, and a person approves what they send.
          </p>
          <div data-hero-cta className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <ButtonLink to="/signup" size="lg" className="w-full sm:w-auto" data-testid="hero-cta">Start free <IconArrowRight className="h-4 w-4" aria-hidden /></ButtonLink>
            {demoEnabled && (
              <Button size="lg" variant="secondary" onClick={demo.start} loading={demo.loading} className="w-full sm:w-auto">
                <IconPlay className="h-4 w-4" aria-hidden /> Try the live demo
              </Button>
            )}
          </div>
          {demo.paused && <DemoPausedNote />}
          <p className="mt-4 text-xs text-subtle">Free forever for 1 domain, 3 mailboxes and 3 agent inboxes. No card.</p>
          {/* R60 (trust): try it without a client mailbox, stated where people decide. */}
          <p className="mt-1 text-xs text-subtle" data-testid="hero-safe-trial">Testing first? Use the live demo or a free test address. No client mailbox needed. <Link to="/trust#try" className="font-medium text-brand-hover hover:underline">How to try it safely</Link></p>
        </div>
        <div className="relative mx-auto mt-14 max-w-6xl px-5 pb-16 sm:mt-16">
          <ProductShot name="mail" alt="The Multies mail screen with a list of threads and an open message." priority />
        </div>
      </section>

      <section id="features" className="scroll-mt-20 border-t border-line" aria-labelledby="areas-title">
        <div className="mx-auto max-w-6xl px-5 py-20 sm:py-24">
          <p className="text-sm font-medium text-brand-hover">Everything in one place</p>
          <h2 id="areas-title" className="mt-2 max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">Stop paying for ten apps that don't talk to each other.</h2>
          <p className="mt-4 max-w-2xl text-muted">Every area works with the others: a thread becomes a task, a contact gets an invoice, a meeting keeps its notes. All of it comes with the free plan.</p>
          <div className="mt-10"><AreaGrid /></div>
          <p className="mt-6 text-sm"><Link to="/features" className="font-medium text-brand-hover hover:underline">See every feature</Link></p>
        </div>
      </section>

      {deeper.map((d, i) => (
        <section key={d.id} id={d.id} className="scroll-mt-20 border-t border-line" aria-labelledby={`${d.id}-title`}>
          <div className={`mx-auto grid max-w-6xl items-center gap-10 px-5 py-20 sm:py-24 ${d.shot ? "lg:grid-cols-2" : ""}`}>
            <div className={d.shot && i % 2 === 0 ? "lg:order-2" : ""}>
              <p className="text-sm font-medium text-brand-hover">{d.kicker}</p>
              <h2 id={`${d.id}-title`} className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">{d.title}</h2>
              <p className="mt-4 max-w-xl text-muted">{d.body}</p>
              <ul className={`mt-6 grid gap-3 text-[15px] ${d.shot ? "" : "sm:grid-cols-2"}`}>
                {d.points.map((p) => (
                  <li key={p} className="flex items-start gap-2.5 text-fg/85"><IconCheck className="mt-1 h-4 w-4 shrink-0 text-brand-hover" aria-hidden />{p}</li>
                ))}
              </ul>
              <p className="mt-6 text-sm"><Link to={d.more} className="font-medium text-brand-hover hover:underline">More about {d.kicker === "AI agents" ? "AI agents" : d.kicker.toLowerCase()}</Link></p>
            </div>
            {d.shot && <ProductShot name={d.shot.name} alt={d.shot.alt} />}
          </div>
        </section>
      ))}

      <section id="trust" className="scroll-mt-20 border-y border-line bg-surface/40" aria-labelledby="trust-title">
        <div className="mx-auto grid max-w-6xl gap-8 px-5 py-16 md:grid-cols-3">
          <div className="md:col-span-1">
            <h2 id="trust-title" className="text-2xl font-semibold tracking-tight">Built for small businesses that own their domain.</h2>
          </div>
          <ul className="grid gap-5 text-[15px] text-muted sm:grid-cols-2 md:col-span-2">
            <li><span className="font-semibold text-fg">Your data in Oceania.</span> Workspace data is stored in the Oceania region. Some services run in the United States, and the <Link to="/trust" className="text-brand-hover underline underline-offset-2">Trust page</Link> lists each one.</li>
            <li><span className="font-semibold text-fg">Free to start.</span> One domain, three mailboxes and every feature, with no card and no trial clock.</li>
            <li><span className="font-semibold text-fg">Priced per business.</span> Add-ons raise limits for the whole workspace, never per person. Guests are free.</li>
            <li><span className="font-semibold text-fg">Open to your tools.</span> A REST API, an MCP server and signed webhooks. <Link to="/developers" className="text-brand-hover underline underline-offset-2">Developer hub</Link></li>
          </ul>
        </div>
      </section>

      <section id="how" className="scroll-mt-20" aria-labelledby="how-title">
        <div className="mx-auto max-w-6xl px-5 py-20 sm:py-24">
          <h2 id="how-title" className="text-3xl font-semibold tracking-tight sm:text-4xl">Set up in about five minutes</h2>
          <ol className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {steps.map((step, i) => (
              <li key={step.t} className="rounded-xl border border-line bg-surface p-5">
                <span className="text-sm font-semibold tabular-nums text-brand-hover">{i + 1}</span>
                <h3 className="mt-2 text-[15px] font-semibold">{step.t}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">{step.b}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="pricing" className="scroll-mt-20 border-t border-line" aria-labelledby="pricing-title">
        <div className="mx-auto max-w-6xl px-5 py-20 sm:py-24">
          <p className="text-sm font-medium text-brand-hover">Pricing</p>
          <h2 id="pricing-title" className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Free, then only what you need.</h2>
          <div className="mt-10"><PlanCards headingLevel={3} /></div>
          <p className="mt-6 text-sm"><Link to="/pricing" className="font-medium text-brand-hover hover:underline">Work out your price</Link></p>
        </div>
      </section>

      <section id="faq" className="scroll-mt-20 border-t border-line" aria-labelledby="faq-title">
        <div className="mx-auto max-w-3xl px-5 py-20 sm:py-24">
          <h2 id="faq-title" className="text-3xl font-semibold tracking-tight">Questions, answered.</h2>
          <dl className="mt-8 divide-y divide-line border-y border-line">
            {faqs.map((f) => (
              <div key={f.q} className="py-5">
                <dt className="text-[15px] font-semibold text-fg">{f.q}</dt>
                <dd className="mt-2 text-[15px] leading-relaxed text-muted">{f.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section id="get-the-app" className="scroll-mt-20 border-t border-line" aria-labelledby="get-app-title">
        <div className="mx-auto max-w-6xl px-5 py-20 sm:py-24"><GetTheApp /></div>
      </section>

      <section className="border-t border-line">
        <div className="mx-auto max-w-6xl px-5 py-20 text-center sm:py-24">
          <h2 className="mx-auto max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">Bring your team, your clients and your agents into one workspace.</h2>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <ButtonLink to="/signup" size="lg" className="w-full sm:w-auto">Start free <IconArrowRight className="h-4 w-4" aria-hidden /></ButtonLink>
            <ButtonLink to="/features" size="lg" variant="secondary" className="w-full sm:w-auto">See every feature</ButtonLink>
          </div>
        </div>
      </section>
    </>
  );
}
