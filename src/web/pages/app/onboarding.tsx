import { useMemo, useState, type FormEvent } from "react";
import { nameLooksLikeEmail } from "@/shared/display-name";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { IconArrowRight, IconChats, IconCheckCircle, IconGlobe, IconMail, IconMention } from "@/web/components/ui/icon";
import { api, ApiError } from "@/web/lib/api";
import { qk } from "@/web/lib/queries";
import type { Me } from "@/web/lib/types";
import { Button } from "@/web/components/ui/button";
import { Card } from "@/web/components/ui/misc";
import { Field, Input, Select } from "@/web/components/ui/input";
import { Logo } from "@/web/components/logo";
import { LegalLine } from "@/web/components/legal-line";
import { FreeAddressCard, useFreeAddress } from "@/web/components/free-address";
import { ConnectMailboxForm, useConnections } from "@/web/components/connect-mailbox";
import type { ConnectionView } from "@/shared/mail-connect";
import { browserTimeZone } from "@/web/lib/format";
import { COUNTRIES, LANGUAGES, cleanLocale, guessCountry, isCountry } from "@/shared/locale";

/** Every IANA zone the browser knows, the person's own first. */
function zones(own: string | null) {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["UTC"];
  return own && !all.includes(own) ? [own, ...all] : all;
}

/** "America/Sao_Paulo" as "Sao Paulo (America), UTC-03:00". */
function zoneLabel(z: string) {
  let offset = "";
  try {
    offset = new Intl.DateTimeFormat("en", { timeZone: z, timeZoneName: "longOffset" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch { /* old browser */ }
  const [region, ...rest] = z.split("/");
  const city = rest.join(" / ").replace(/_/g, " ");
  return `${city || region}${city ? ` (${region})` : ""}${offset ? `, ${offset.replace("GMT", "UTC")}` : ""}`;
}

/**
 * One time onboarding, shown before the app the first time a person signs in: their name, time zone
 * and language, and for the workspace's owner or admins its company name and country. Everything is
 * filled in from the browser. Then three ways to get email working, or skip straight to the app.
 */
export function Onboarding({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [step, setStep] = useState<"about" | "email">("about");
  const own = browserTimeZone();
  const browserLocale = cleanLocale(typeof navigator !== "undefined" ? navigator.language : null) ?? "en";
  const workspace = !!me.onboarding?.workspace;
  const placeholderName = /'s workspace$/i.test(me.organization?.name ?? "");
  const [f, setF] = useState({
    name: nameLooksLikeEmail(me.user.name, me.user.email) ? "" : me.user.name ?? "", // R41 (MB-224): never prefilled with the email
    company: placeholderName ? "" : me.organization?.name ?? "",
    country: guessCountry(browserLocale, own) ?? (me.organization?.country && isCountry(me.organization.country) ? me.organization.country : ""),
    timezone: me.user.timezone ?? own ?? me.organization?.timezone ?? "UTC",
    locale: me.user.locale ?? browserLocale,
  });
  const [errors, setErrors] = useState<Partial<Record<keyof typeof f | "form", string>>>({});
  const regionNames = useMemo(() => { try { return new Intl.DisplayNames([f.locale, "en"], { type: "region" }); } catch { return null; } }, [f.locale]);
  const languageNames = useMemo(() => { try { return new Intl.DisplayNames([f.locale, "en"], { type: "language" }); } catch { return null; } }, [f.locale]);
  const countries = useMemo(() => [...COUNTRIES].map((c) => ({ c, name: regionNames?.of(c) ?? c })).sort((a, b) => a.name.localeCompare(b.name)), [regionNames]);
  const languages = useMemo(() => {
    const list: string[] = [...LANGUAGES];
    if (!list.includes(f.locale)) list.unshift(f.locale);
    return list.map((l) => ({ l, name: languageNames?.of(l) ?? l }));
  }, [languageNames, f.locale]);
  const save = useMutation({
    mutationFn: () => api.post("/account/onboarding", {
      name: f.name.trim(), timezone: f.timezone, locale: f.locale,
      ...(workspace ? { company: f.company.trim() || undefined, country: f.country || undefined, workspaceTimezone: f.timezone } : {}),
    }),
    onSuccess: () => setStep("email"),
    onError: (e) => setErrors({ form: e instanceof ApiError ? e.message : "That didn't save. Try again." }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (!f.name.trim()) next.name = "Enter your name.";
    if (workspace && !f.country) next.country = "Pick your country.";
    setErrors(next);
    if (!Object.keys(next).length) save.mutate();
  };
  const finish = () => qc.invalidateQueries({ queryKey: qk.me });
  const set = (k: keyof typeof f) => (v: string) => { setF({ ...f, [k]: v }); setErrors({ ...errors, [k]: undefined }); };

  return (
    <div className="min-h-dvh bg-bg px-4 py-10 sm:py-16">
      <div className="mx-auto max-w-xl">
        <Logo className="mx-auto h-7" />
        {step === "about" ? (
          <Card className="mt-8 p-6 sm:p-8">
            <h1 className="text-2xl font-semibold tracking-tight">Welcome to Multies</h1>
            <p className="mt-1.5 text-sm text-muted">A few details so times, dates and your workspace look right wherever you are. We filled in what your browser told us.</p>
            <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
              <Field label="Your name" error={errors.name}>{(fp) => <Input {...fp} value={f.name} onChange={(e) => set("name")(e.target.value)} autoComplete="name" placeholder="Your name" />}</Field>
              {workspace && (
                <Field label="Company or team" hint="Optional. You can change it later in Settings.">{(fp) => <Input {...fp} value={f.company} onChange={(e) => set("company")(e.target.value)} autoComplete="organization" placeholder="Acme" />}</Field>
              )}
              {workspace && (
                <Field label="Country" error={errors.country}>{(fp) => (
                  <Select {...fp} value={f.country} onChange={(e) => set("country")(e.target.value)} autoComplete="country">
                    <option value="">Choose a country</option>
                    {countries.map(({ c, name }) => <option key={c} value={c}>{name}</option>)}
                  </Select>
                )}</Field>
              )}
              <Field label="Time zone" hint="Chat, mail, meetings and reminders show in this zone.">{(fp) => (
                <Select {...fp} value={f.timezone} onChange={(e) => set("timezone")(e.target.value)}>
                  {zones(own).map((z) => <option key={z} value={z}>{zoneLabel(z)}</option>)}
                </Select>
              )}</Field>
              <Field label="Language" hint="Multies is in English for now. We use this for dates and numbers, and for your language when it's ready.">{(fp) => (
                <Select {...fp} value={f.locale} onChange={(e) => set("locale")(e.target.value)}>
                  {languages.map(({ l, name }) => <option key={l} value={l}>{name}</option>)}
                </Select>
              )}</Field>
              {errors.form && <p role="alert" className="text-sm text-bad">{errors.form}</p>}
              <Button type="submit" size="lg" className="w-full" loading={save.isPending}>Continue</Button>
            </form>
          </Card>
        ) : (
          <EmailPaths onDone={finish} />
        )}
        <div className="mt-8 text-center text-xs text-subtle"><LegalLine /></div>
      </div>
    </div>
  );
}

/** Three ways to get email working, or skip: tasks, chat and meetings work without any email. */
function EmailPaths({ onDone }: { onDone: () => void }) {
  const free = useFreeAddress();
  const connections = useConnections();
  const canConnect = !!connections.data?.enabled;
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState<ConnectionView | null>(null);
  const domain = free.data?.enabled ? free.data.domain : null;
  return (
    <div className="mt-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">How do you want to use email?</h1>
        <p className="mt-1.5 text-sm text-muted">Pick one now or later. Tasks, chat and meetings work straight away either way.</p>
      </div>
      {domain && (
        <div data-testid="path-free">
          <FreeAddressCard />
        </div>
      )}
      <Card className="flex items-start gap-3 p-4 sm:p-5" data-testid="path-connect">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-fill text-muted"><IconMail className="h-4 w-4" aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 font-semibold">Connect your existing email{!canConnect && connections.isFetched && <span className="rounded-full bg-fill px-2 py-0.5 text-[11px] font-medium text-muted">Not on this server</span>}</h2>
          {connected ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-3" data-testid="connect-done">
              <span className="inline-flex items-center gap-1.5 text-sm text-ok"><IconCheckCircle className="h-4 w-4" aria-hidden />{connected.email} is connected. Recent mail is coming in now.</span>
              <Link to={`/app/mail?mailbox=${connected.mailboxId}`} onClick={onDone} className="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline">Open inbox <IconArrowRight className="h-3.5 w-3.5" /></Link>
            </div>
          ) : (
            <>
              <p className="mt-0.5 text-sm text-muted">Gmail, Outlook, Yahoo, iCloud, Zoho, Fastmail, GMX or any IMAP mailbox, with your real address. Mail syncs both ways and replies go out through your own provider.</p>
              {canConnect && !connecting && (
                <button type="button" onClick={() => setConnecting(true)} className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline" data-testid="path-connect-open">Connect my email <IconArrowRight className="h-3.5 w-3.5" /></button>
              )}
              {canConnect && connecting && <ConnectMailboxForm className="mt-4" oauth={connections.data?.oauth} onConnected={setConnected} />}
            </>
          )}
        </div>
      </Card>
      <Card className="flex items-start gap-3 p-4 sm:p-5" data-testid="path-domain">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-fill text-muted"><IconGlobe className="h-4 w-4" aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">Use your own domain</h2>
          <p className="mt-0.5 text-sm text-muted">Addresses like you@yourcompany.com. We show the exact DNS records and check them for you.</p>
          <Link to="/app/domains" onClick={onDone} className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline">Add my domain <IconArrowRight className="h-3.5 w-3.5" /></Link>
        </div>
      </Card>
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
        <span className="inline-flex items-center gap-1.5 text-sm text-subtle">{domain ? <IconMention className="h-4 w-4" aria-hidden /> : <IconChats className="h-4 w-4" aria-hidden />}You can change this any time.</span>
        <Button onClick={onDone} variant="secondary">Go to Multies <IconArrowRight className="h-4 w-4" /></Button>
      </div>
    </div>
  );
}
