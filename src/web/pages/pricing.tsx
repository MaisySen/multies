import { useState } from "react";
import { aiCostAnswer } from "@/shared/ai-public-copy";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { IconMinus, IconPlus } from "@/web/components/ui/icon";
import { PlanCards } from "@/web/components/plan-cards";
import { ADDON_ORDER, ADDONS, PLANS, YEARLY_MONTHS_CHARGED, chargeFor, effectiveLimits, formatPlanPrice, yearlyOnly, type AddonId, type AddonQuantities, type BillingInterval } from "@/shared/plans";
import { Button } from "@/web/components/ui/button";
import { LOCALE } from "@/shared/locale";
import { RESIDENCY_ANSWER } from "@/shared/residency";
import { OFFER_COPY } from "@/shared/offers";

const countryParam = () => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("country"));

/** The price in the visitor's own currency, approximate and for display only. Billing stays in A$. */
function LocalPrice({ aud }: { aud: number }) {
  const fx = useQuery({ queryKey: ["fx"], staleTime: 3600_000, retry: false,
    queryFn: () => api.get<{ currency: string; rate: number | null; date?: string | null }>(`/fx${countryParam() ? `?country=${encodeURIComponent(countryParam()!)}` : ""}`) });
  if (!fx.data?.rate || fx.data.currency === "AUD") return null;
  let local: string;
  try { local = new Intl.NumberFormat(undefined, { style: "currency", currency: fx.data.currency, maximumFractionDigits: 0 }).format(aud * fx.data.rate); } catch { return null; }
  return <p className="mt-1 text-sm text-muted" data-testid="local-price">About {local}. You're billed in Australian dollars (A$); your bank sets the final amount.</p>;
}

const FAQ: { q: string; a: string }[] = [
  { q: "Is Free really free forever?", a: "Yes. One domain, three mailboxes for three people, 3 GB, mail apps and three agent inboxes, with no card and no trial clock. The limits are in our terms, and if they ever change, existing free workspaces keep what they have." },
  { q: "What do tasks, boards, docs and contacts cost?", a: "Nothing. They come with every workspace, Free included: projects, tasks, custom fields, the portfolio, docs with live co-editing, contacts, deals, time tracking, forms, reports and video meetings for everyone on your team, with no per person price. Automations run up to 1,000 times a month on Free." },
  { q: "Do guests cost anything?", a: "No. Guests are free on every plan, Free included, and they never count as people on your plan. Invite a client to one project by email: they see its tasks, comments and docs, and can comment and upload files. Nothing else in your workspace." },
  { q: "Why per business and not per person?", a: "Most small teams share mailboxes, and adding a person shouldn't cost another A$10 a month. Add-ons raise limits for the whole workspace." },
  { q: "What does AI cost?", a: aiCostAnswer() },
  { q: "Why do small totals bill yearly?", a: "A card payment in Australia costs about 1.7 percent plus 30 cents, so a A$1 monthly charge would lose a third to fees. When your add-ons come to less than A$5 a month we charge once a year, at ten times the monthly price. At A$5 or more you choose monthly or yearly." },
  // R62: the offers come from src/shared/offers.ts, the same source as the terms, billing settings and llms.txt.
  { q: "Is paying yearly cheaper?", a: OFFER_COPY.yearly },
  { q: "Is there a launch offer?", a: OFFER_COPY.launch },
  { q: "Can I earn credit by referring a business?", a: OFFER_COPY.referral },
  { q: "What are agent inboxes?", a: "Email addresses for AI agents. Create one with a single API call or from an MCP client, read threads as JSON, get new mail by webhook or a live stream, and send with caps and an optional human approval step. Every action is in the audit log." },
  // R60 (trust): the facts come from src/shared/residency.ts, the same source as /trust and /privacy.
  { q: "Where is my email stored?", a: `${RESIDENCY_ANSWER} The full list, store by store, is on our Trust page.` },
  { q: "Can I try Multies without connecting a client mailbox?", a: "Yes. Open the live demo, a sample workspace with made up mail that needs no sign up and is deleted after 24 hours. Or sign up free and take a test address like yourname@mail.multies.si to send and receive real mail. Connect a client mailbox only when you are ready; removing it deletes our copy." },
  { q: "Will this mean more admin?", a: "It should mean less. Keep your current address by connecting the mailbox over IMAP, import contacts from any address book as a vCard or CSV file, and run mail, tasks, chat and meetings under one sign in. Multies does not replace accounting or industry specific software; it connects to them through webhooks and the API." },
  { q: "Does it connect to my CRM or other tools?", a: "Any CRM or platform that can send or receive webhooks, or has an API, can pass leads to and from Multies today. There is no ready made connector for specific industry platforms. WhatsApp enquiries in the shared inbox are planned and not available yet." },
  { q: "I'm on an older paid plan. What changes?", a: "Nothing unless you want it to. Your plan, limits and price stay as they are, and you can add add-ons to the same subscription, or move to Free and keep only the add-ons you use." },
];

export function PricingPage() {
  return (
    <div className="mx-auto max-w-6xl px-5 pb-24 pt-32 sm:pt-40">
      <div className="mx-auto mb-14 max-w-2xl text-center">
        <h1 className="text-fg text-4xl font-semibold tracking-tight sm:text-5xl lg:-mx-12">Free for your business. <span className="max-sm:block lg:block">A few dollars for what you add.</span></h1>
        <p className="mt-4 text-[17px] text-muted">Email on your own domain for your team and your AI agents, with tasks, boards, docs and contacts built in. No per person pricing, ever.</p>
        <p className="mt-3 text-sm text-muted">{/* R58 (MB-237) */}<Link to="/startups" className="font-medium text-brand-hover hover:underline">What Free includes for small teams</Link> <span aria-hidden>·</span> <Link to="/switch" className="font-medium text-brand-hover hover:underline">Move your work over</Link></p>
      </div>
      <PlanCards headingLevel={2} />
      <Calculator />
      <section className="mx-auto mt-24 max-w-3xl" aria-labelledby="faq">
        <h2 id="faq" className="text-2xl font-semibold tracking-tight">Questions</h2>
        <dl className="mt-6 divide-y divide-line border-y border-line">
          {FAQ.map((f) => (
            <div key={f.q} className="py-5">
              <dt className="font-medium">{f.q}</dt>
              <dd className="mt-2 max-w-[30rem] text-sm leading-relaxed text-muted">{f.a}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-sm text-muted">Where each kind of data is stored, how to try Multies safely and what it connects to: <Link to="/trust#where" className="font-medium text-brand-hover hover:underline">Trust and data</Link>.</p>
      </section>
    </div>
  );
}

/** Pick add-ons, see the total, the interval and the per person comparison. */
function Calculator() {
  const [people, setPeople] = useState(10);
  const [addons, setAddons] = useState<AddonQuantities>({ mailboxes: 2 });
  const [interval, setInterval] = useState<BillingInterval>("month");
  const charge = chargeFor(addons, 0, interval);
  const limits = effectiveLimits(PLANS.starter, addons);
  const set = (id: AddonId, n: number) => setAddons({ ...addons, [id]: Math.max(0, Math.min(ADDONS[id].maxQuantity, n)) });
  const shortOfSeats = limits.seats < people;
  return (
    <section className="mt-20 rounded-2xl border border-line bg-surface p-6 sm:p-8" aria-labelledby="calc">
      <h2 id="calc" className="text-xl font-semibold tracking-tight">Work out your price</h2>
      <div className="mt-6 grid gap-8 lg:grid-cols-[1.2fr_1fr]">
        <div>
          <label className="flex items-center justify-between gap-4 text-sm">
            <span className="text-muted">People on your team</span>
            <input type="number" min={1} max={500} value={people} onChange={(e) => setPeople(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
              className="w-24 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-right tabular-nums transition-[border-color,box-shadow] duration-150 ease-out focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/15 max-sm:min-h-11" />
          </label>
          <ul className="mt-4 divide-y divide-line border-y border-line">
            {ADDON_ORDER.map((id) => {
              const a = ADDONS[id];
              const qty = addons[id] ?? 0;
              return (
                <li key={id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span>{a.name} <span className="text-subtle">{formatPlanPrice(a.priceMonthly)}{a.maxQuantity === 1 ? "" : ` per ${a.unit}`}</span></span>
                  <span className="flex items-center gap-1" role="group" aria-label={`${a.name} quantity`}>
                    <Button size="sm" variant="secondary" className="max-sm:min-w-11" aria-label={`One less ${a.name.toLowerCase()}`} disabled={!qty} onClick={() => set(id, qty - 1)}><IconMinus className="h-3.5 w-3.5" /></Button>
                    <output className="w-8 text-center tabular-nums">{qty}</output>
                    <Button size="sm" variant="secondary" className="max-sm:min-w-11" aria-label={`One more ${a.name.toLowerCase()}`} disabled={qty >= a.maxQuantity} onClick={() => set(id, qty + 1)}><IconPlus className="h-3.5 w-3.5" /></Button>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="flex flex-col justify-between gap-6 rounded-xl bg-canvas/60 p-5">
          <div>
            <p className="text-sm text-muted">Multies for your whole team</p>
            <p className="mt-1 text-4xl font-semibold tracking-tight tabular-nums" aria-live="polite">
              {charge.amount === 0 ? "A$0" : formatPlanPrice(charge.amount)}<span className="text-base font-normal text-subtle"> {charge.amount === 0 ? "forever" : charge.interval === "year" ? "a year" : "a month"}</span>
            </p>
            {charge.interval === "year" && charge.amount > 0 && <p className="mt-1 text-sm text-muted">{YEARLY_MONTHS_CHARGED} months for 12: you save {formatPlanPrice(charge.yearlySaving)} a year.</p>}
            {/* R62: monthly or yearly with two months free; under A$5 a month it bills yearly only. */}
            {charge.monthly > 0 && !yearlyOnly(charge.monthly) && (
              <div className="mt-3 inline-flex rounded-lg bg-fill p-0.5 text-[13px]" role="group" aria-label="Billing interval" data-testid="pricing-interval">
                {(["month", "year"] as const).map((i) => (
                  <button key={i} type="button" aria-pressed={charge.interval === i} onClick={() => setInterval(i)}
                    className={`rounded-md px-3 py-1 transition-colors motion-reduce:transition-none max-sm:min-h-11 ${charge.interval === i ? "bg-surface font-medium text-fg shadow-sm" : "text-muted hover:text-fg"}`}>
                    {i === "month" ? "Monthly" : "Yearly, 2 months free"}
                  </button>
                ))}
              </div>
            )}
            {charge.amount > 0 && <LocalPrice aud={charge.amount} />}
            <p className="mt-3 text-sm text-muted">
              {limits.domains} domain{limits.domains === 1 ? "" : "s"}, {limits.mailboxes} mailboxes, {limits.seats} people, {(limits.storageMb / 1024).toLocaleString(LOCALE)} GB and {limits.agentInboxes} agent inboxes. AI is yours to bring, free.
            </p>
            {shortOfSeats && <p className="mt-2 text-sm text-warn">That's room for {limits.seats} people. Add a mailbox pack for every five more.</p>}
          </div>
        </div>
      </div>
    </section>
  );
}
