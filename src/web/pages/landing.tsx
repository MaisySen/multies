import { IconArrowRight, IconPlay } from "@/web/components/ui/icon";
import { Button, ButtonLink } from "@/web/components/ui/button";
import { HeroVisual } from "@/web/components/hero-visual";
import { PlanCards } from "@/web/components/plan-cards";
import { useConfig } from "@/web/lib/queries";
import { useStartDemo } from "@/web/lib/demo";

const features = [
  { title: "Mailboxes for your team", body: "Real inboxes for people, aliases for roles. sales@ can reach three founders and a Gmail. Webmail that works on any device." },
  { title: "Inboxes for your AI agents", body: "Give an agent its own address with one API call. It reads mail as clean JSON, with one-time codes and links pulled out, and replies in the thread." },
  { title: "You approve what agents send", body: "By default every message an agent writes waits for a person. Set daily caps and allowed recipients, and see every action in the audit log." },
  { title: "Bring your own AI", body: "Connect any AI app or agent through MCP, free. The built-in MCP server reads, searches and replies, scoped to one agent's key." },
  { title: "An assistant on your own key", body: "Summaries, drafted replies and sorting with your own model provider key, billed by them, never by us. Invoice reminders that get firmer the longer a bill goes unpaid need no key." },
  { title: "Your domain, signed properly", body: "Every domain gets its own DKIM key, live DNS checks, bounce handling and DMARC reports, so your mail lands in inboxes." },
];

const work = [
  { title: "Tasks from email", body: "One click on any thread makes a task with the subject, the latest message and a link back. Assign it to a person or an agent, set a due date and priority, add subtasks." },
  { title: "Boards, lists and timelines", body: "Drag cards across a board, sort a list, plan on a calendar or a timeline. Each project has its own statuses, and you can save the filters you use." },
  { title: "Docs beside the work", body: "Write briefs and meeting notes, then link them to a project, a task, a thread or a contact. Agents can read and add to them." },
  { title: "Contacts that build themselves", body: "Everyone you email becomes a contact with their company, and a timeline of every thread, task and deal. A simple pipeline board tracks deals in AUD." },
  { title: "Time, forms and reports", body: "Start a timer on any task or log time by hand, then see a timesheet per person and project. Public forms turn website enquiries into tasks. Dashboards show what is open, overdue and won." },
  { title: "Custom fields, guests and a portfolio", body: "Add fields like Budget in AUD, Stage or Client approved to any project, then filter, sort and group the board by them. Invite clients as guests for free: they see that one project, comment and upload files. The portfolio shows every project's progress, overdue work and health in one table." },
  { title: "Team chat beside your mail", body: "Channels, direct messages and threads, with @mentions, files and task links that open in one click. Turn any message into a task. Share a project's channel with its guests, and let agents post and read through the API." },
  { title: "Goals, templates and repeating tasks", body: "Set goals with key results in AUD, numbers or tasks done, and watch progress roll up. Start projects from a starter gallery or your own templates. Tasks can repeat daily, weekly on chosen days, monthly or yearly." },
  { title: "One inbox for what needs you", body: "Mentions, work assigned to you, comments, approvals and anything due soon land in one notifications inbox. Choose per category what shows there and what buzzes your phone." },
  { title: "Video meetings from a thread", body: "Start a meeting from an email, a task or a contact. Guests join from a link in their browser, and the calendar invite goes out from your own address. Record a call for a transcript and summary." },
];

const faqs = [
  { q: "Is it really free?", a: "Yes. One domain, three mailboxes, 3 GB, three agent inboxes, for as long as you like, with no card. Add-ons cost A$1 to A$5 a month each, for the whole business, never per person." },
  { q: "What does the AI cost?", a: "Nothing from us. Bring your own AI: connect any AI app or agent through MCP, free. Multies never resells AI or meters it." },
  { q: "Can an agent send email without me?", a: "Only if you let it. New agents need a person to approve every message. You can relax that to only mail leaving Multies, or turn it off, and set a daily cap and a list of who it may write to." },
  { q: "Do I need to move my domain?", a: "No. Keep your domain wherever it's registered. You add a few DNS records. We show you each one, check them live, and tell you when everything's right." },
  { q: "How does inbound mail reach Multies?", a: "Your MX records point at Cloudflare Email Routing. A small Email Worker (we give you the code) signs each message and hands it to Multies, which files it in the right mailbox, alias or catch-all." },
  { q: "Can I send mail too?", a: "Yes. Outbound mail goes through a transactional email provider with your domain's SPF, DKIM and DMARC in place, so it lands in inboxes rather than spam." },
  { q: "What happens if I already use Google Workspace?", a: "We'll spot your existing MX and SPF records and show you exactly what to change, including a merged SPF record, so nothing breaks during the move." },
  { q: "Do I still need Monday or ClickUp?", a: "For many small teams, no. Multies has tasks with boards, lists, a calendar and a timeline with dependencies, custom fields (text, number, AUD currency, date, select, multi select, person, checkbox and link) you can filter, sort and group a board by, repeating tasks, project templates, goals with key results, team chat with threads, a notifications inbox, free guests for your clients, a portfolio of every project with its health, docs that two people can edit at once, contacts, deals, time tracking, public forms, report dashboards, sprints with a burndown, a triage queue, a shared inbox with assignments and team notes, video calls in chat with screen share, meeting notes whose action items become tasks, calendar sync, a workload view of who has what each week, and simple automations, all built around your mail. It is still simpler than those tools: no app marketplace, no formula or rollup fields, and fewer automation recipes. If you rely on those, keep them and connect Multies with webhooks, the API and MCP." },
  { q: "Is my mail stored in Australia?", a: "Not yet. Our database sits in Cloudflare's Oceania region, which is a placement hint rather than a promise of a country, and some providers we use are in the United States. We're preparing Sydney hosting and will only say so once it's true." },
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
          <h1 className="mx-auto max-w-4xl text-[40px] font-semibold leading-[1.05] tracking-[-0.035em] text-fg sm:text-5xl md:text-6xl">
            Email for your team and your AI agents.
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-[17px] leading-relaxed text-muted">
            Free for startups and small businesses, on your own domain. Turn any email into a task, run projects on boards, and see every thread with a client in one place. A person approves what agents send.
          </p>
          <div data-hero-cta className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <ButtonLink to="/signup" size="lg" className="w-full sm:w-auto" data-testid="hero-cta">Start free <IconArrowRight className="h-4 w-4" aria-hidden /></ButtonLink>
            {demoEnabled && (
              <Button size="lg" variant="secondary" onClick={demo.start} loading={demo.loading} className="w-full sm:w-auto">
                <IconPlay className="h-4 w-4" aria-hidden /> Try the live demo
              </Button>
            )}
          </div>
          <p className="mt-4 text-xs text-subtle">Free forever for 1 domain, 3 mailboxes and 3 agent inboxes. No card.</p>
          <p className="mt-1 text-xs text-subtle">Bring your own AI: connect any AI app or agent through MCP, free.</p>
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
            <p className="mt-4 max-w-md text-muted">Whether mail lands is decided by four DNS records. Multies checks each one live, says what's wrong in plain words, and merges the SPF record you already have instead of breaking it.</p>
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

      <section id="agents" className="scroll-mt-20 border-t border-line">
        <div className="mx-auto grid max-w-6xl gap-12 px-5 py-20 sm:py-24 md:grid-cols-2 md:items-center">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">An inbox your agent can use, on your domain.</h2>
            <p className="mt-4 leading-relaxed text-muted">One call creates the address and a key that only works for it. Mail arrives as JSON by webhook or stream. Replies wait in your approval queue until someone says yes.</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <ButtonLink to="/agents" variant="secondary">Read the quickstart <IconArrowRight className="h-4 w-4" /></ButtonLink>
            </div>
          </div>
          <pre tabIndex={0} className="overflow-x-auto rounded-xl border border-line bg-surface p-4 font-mono text-[12px] leading-relaxed text-fg/85" aria-label="Example: create an agent inbox">{`curl https://multies.si/api/v1/agents \\
  -H "Authorization: Bearer $MYMAIL_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"name": "Invoice bot", "localPart": "invoices"}'

{
  "agent": {
    "address": "invoices@yourbusiness.com.au",
    "approvalMode": "always",
    "sendCapDaily": 100
  },
  "apiKey": { "secret": "mm_live_..." }
}`}</pre>
        </div>
      </section>

      <section id="work" className="scroll-mt-20 border-t border-line">
        <div className="mx-auto max-w-6xl px-5 py-20 sm:py-24">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Turn email into work, without another app.</h2>
            <p className="mt-4 leading-relaxed text-muted">Tasks, boards, docs and contacts sit next to your inbox and are free in every plan, Free included. Replies on a thread show up on its task, so nobody has to copy and paste.</p>
          </div>
          <dl className="mt-10 grid gap-x-10 sm:grid-cols-2 lg:grid-cols-4">
            {work.map(({ title, body }) => (
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
          <h2 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Free, then only what you need.</h2>
          <p className="mt-4 text-muted">Add-ons from A$1 a month, priced per business. A team of ten pays the same as a team of two.</p>
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
          <h2 className="mx-auto max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">Bring your team and your agents into one inbox.</h2>
          <p className="mx-auto mt-4 max-w-lg text-muted">Set it up on your domain today. Free, with no card.</p>
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
