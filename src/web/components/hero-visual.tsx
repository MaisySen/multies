import { Check, Inbox, Globe, Users, Send, Star, Search, Shield } from "lucide-react";

const rows = [
  { from: "Priya Raman", subject: "Following up from demo day", snippet: "Loved the demo yesterday. Could we find 30 minutes…", time: "9:41", unread: true },
  { from: "Maria Gonzalez", subject: "Can we move our team over this week?", snippet: "We have 14 people on Workspace today. If we point…", time: "8:12", unread: true },
  { from: "Payments", subject: "Receipt for your payment: $1,280.00", snippet: "Thanks for your payment. Amount paid: $1,280.00…", time: "Tue" },
  { from: "Jordan Lee", subject: "Partnership idea", snippet: "We build onboarding tooling for B2B SaaS and a lot…", time: "Mon" },
  { from: "DMARC Reports", subject: "Aggregate report: 100% aligned", snippet: "SPF aligned 1,204 / 1,204 · DKIM aligned 1,204…", time: "Sun" },
];

const checks = ["Ownership", "MX → Cloudflare", "SPF", "DKIM (2048-bit)", "DMARC quarantine"];

/** An illustration of the product UI for the landing page (not a screenshot). */
export function HeroVisual() {
  return (
    <div className="relative mx-auto max-w-5xl" aria-hidden>
      <div className="relative overflow-hidden rounded-2xl border border-line-strong bg-surface/90 shadow-[0_40px_120px_-30px_rgb(0_0_0/0.9)] backdrop-blur">
        <div className="flex h-10 items-center gap-2 border-b border-line px-4">
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" /><span className="h-2.5 w-2.5 rounded-full bg-white/15" /><span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          <div className="mx-auto hidden h-6 w-72 items-center justify-center rounded-md bg-white/[0.04] text-[11px] text-subtle sm:flex">app.yourcompany.com/mail</div>
        </div>
        <div className="grid grid-cols-[180px_1fr] text-left max-md:grid-cols-1">
          <aside className="space-y-0.5 border-r border-line p-3 text-[12.5px] max-md:hidden">
            {[{ i: Inbox, l: "Inbox", n: "2", a: true }, { i: Star, l: "Starred" }, { i: Send, l: "Sent" }, { i: Globe, l: "Domains" }, { i: Users, l: "Mailboxes" }, { i: Shield, l: "Activity" }].map(({ i: I, l, n, a }) => (
              <div key={l} className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 ${a ? "bg-white/[0.07] text-fg" : "text-muted"}`}>
                <I className="h-3.5 w-3.5" />{l}{n && <span className="ml-auto rounded bg-brand px-1.5 text-[10px] font-semibold text-brand-fg">{n}</span>}
              </div>
            ))}
          </aside>
          <div>
            <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
              <Search className="h-3.5 w-3.5 text-subtle" /><span className="text-[12px] text-subtle">Search mail</span>
              <span className="ml-auto text-[11px] text-subtle">founders@northwind.com</span>
            </div>
            {rows.map((r) => (
              <div key={r.subject} className="flex items-start gap-3 border-b border-line/70 px-4 py-3 last:border-0">
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${r.unread ? "bg-brand" : "bg-transparent"}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className={`truncate text-[13px] ${r.unread ? "font-semibold text-fg" : "text-fg/80"}`}>{r.from}</span>
                    <span className="shrink-0 text-[11px] text-subtle">{r.time}</span>
                  </div>
                  <div className={`truncate text-[12.5px] ${r.unread ? "text-fg/90" : "text-muted"}`}>{r.subject}</div>
                  <div className="truncate text-[12px] text-subtle">{r.snippet}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="absolute -bottom-8 -right-4 w-64 rounded-xl border border-line-strong bg-elevated/95 p-4 shadow-pop backdrop-blur max-sm:hidden lg:-right-10">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[13px] font-semibold">northwind.com</span>
          <span className="rounded-full border border-ok/20 bg-ok-soft px-2 py-0.5 text-[10.5px] font-medium text-ok">Verified</span>
        </div>
        <ul className="space-y-2">
          {checks.map((c, i) => (
            <li key={c} className="flex items-center gap-2 text-[12.5px] text-fg/85" style={{ animation: `mm-check-in 400ms ${300 + i * 160}ms both` }}>
              <span className="grid h-4 w-4 place-items-center rounded-full bg-ok/15"><Check className="h-3 w-3 text-ok" /></span>{c}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
