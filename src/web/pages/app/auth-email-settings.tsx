/**
 * R27: Settings, Sign-up emails. The auth emails of a workspace's own app (sign-up confirmation, password
 * reset, magic link and the rest) sent through the Multies auth email hook (R25, MB-60), branded per
 * workspace with an optional second language block. Admins only; a live preview follows every change.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconKey, IconMail, IconRefresh, IconSend } from "@/web/components/ui/icon";
import { toast } from "sonner";
import { api, ApiError } from "@/web/lib/api";
import { useMe } from "@/web/lib/queries";
import { showError } from "@/web/lib/show-error";
import { CopyButton, Skeleton, Switch } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { Section } from "./settings";

type Template = { subject?: string; intro?: string; buttonLabel?: string };
interface Branding { logoUrl?: string; brandColor?: string; replyTo?: string; footer?: string; templates?: Record<string, Template>; secondaryLanguage?: { lang?: string; templates: Record<string, Template>; note?: string } }
interface Settings {
  id: string; enabled: boolean; senderName: string | null; from: string; fromDisplayName: string | null; appName: string; supabaseUrl: string;
  branding: Branding; endpointUrl: string; secret: { set: boolean; masked: string | null }; testSendsLeft: number; lastUsedAt: string | null;
  /** AIS1 (row 44): false when the saved From may no longer send sign-up emails (it keeps sending until changed). */
  fromAllowed?: boolean;
}
interface SettingsResponse { settings: Settings | null; senders: { address: string; displayName: string }[]; types: string[]; testSendsPerHour: number }
interface Preview { subject: string; html: string; to: string }

const TYPE_LABEL: Record<string, string> = {
  signup: "Sign-up confirmation", recovery: "Password reset", magiclink: "Magic link", invite: "Invite",
  email_change: "Email change", email: "Sign-in code", reauthentication: "Confirmation code",
};

interface Draft {
  enabled: boolean; senderName: string; from: string; appName: string; supabaseUrl: string; brandColor: string; logoUrl: string;
  templates: Record<string, Template>; lang: string; second: Record<string, Template>; note: string;
}
const fromSettings = (s: Settings | null, senders: SettingsResponse["senders"]): Draft => ({
  enabled: s?.enabled ?? true, senderName: s?.senderName ?? "", from: (s?.fromAllowed === false ? undefined : s?.from) ?? senders[0]?.address ?? "", appName: s?.appName ?? "",
  supabaseUrl: s?.supabaseUrl ?? "", brandColor: s?.branding.brandColor ?? "", logoUrl: s?.branding.logoUrl ?? "",
  templates: s?.branding.templates ?? {}, lang: s?.branding.secondaryLanguage?.lang ?? "", second: s?.branding.secondaryLanguage?.templates ?? {},
  note: s?.branding.secondaryLanguage?.note ?? "",
});
const clean = (t: Record<string, Template>, types: string[]) => Object.fromEntries(types.map((type) => {
  const v = t[type] ?? {};
  const out: Template = {};
  if (v.subject?.trim()) out.subject = v.subject.trim();
  if (v.intro?.trim()) out.intro = v.intro.trim();
  if (v.buttonLabel?.trim()) out.buttonLabel = v.buttonLabel.trim();
  return [type, Object.keys(out).length ? out : null];
}));
const brandingOf = (d: Draft, types: string[]) => {
  const second = clean(d.second, types);
  const hasSecond = Object.values(second).some(Boolean) || !!d.note.trim();
  return {
    brandColor: d.brandColor.trim() || null, logoUrl: d.logoUrl.trim() || null, templates: clean(d.templates, types),
    secondaryLanguage: hasSecond ? { ...(d.lang.trim() ? { lang: d.lang.trim() } : {}), templates: second, ...(d.note.trim() ? { note: d.note.trim() } : {}) } : null,
  };
};

export function AuthEmailSettings() {
  const me = useMe();
  if (me.data?.organization?.role === "member") return <p className="text-sm text-muted">Sign-up emails are managed by workspace admins.</p>;
  return <AuthEmailSettingsForm />;
}

function AuthEmailSettingsForm() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["auth-email-settings"], queryFn: () => api.get<SettingsResponse>("/auth-email-settings") });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [type, setType] = useState("signup");
  const [shownSecret, setShownSecret] = useState<string | null>(null);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => { if (q.data && !draft) setDraft(fromSettings(q.data.settings, q.data.senders)); }, [q.data, draft]);
  const types = useMemo(() => q.data?.types ?? ["signup"], [q.data?.types]);
  const branding = useMemo(() => (draft ? brandingOf(draft, types) : null), [draft, types]);

  // Live preview: re-render a moment after each change. Invalid values keep the last good preview.
  useEffect(() => {
    if (!draft || !branding) return;
    const t = setTimeout(() => {
      api.post<{ preview: Preview }>("/auth-email-settings/preview", { type, appName: draft.appName || undefined, branding })
        .then((r) => setPreview(r.preview)).catch(() => undefined);
    }, 250);
    return () => clearTimeout(t);
  }, [draft, branding, type]);

  const save = useMutation({
    mutationFn: () => api.put<{ settings: Settings; secret?: string }>("/auth-email-settings", {
      enabled: draft!.enabled, senderName: draft!.senderName.trim() || null, from: draft!.from, ...(draft!.appName.trim() ? { appName: draft!.appName.trim() } : {}),
      ...(draft!.supabaseUrl.trim() ? { supabaseUrl: draft!.supabaseUrl.trim() } : {}), branding,
    }),
    onSuccess: (r) => {
      setErrors({});
      if (r.secret) setShownSecret(r.secret);
      qc.setQueryData<SettingsResponse>(["auth-email-settings"], (old) => (old ? { ...old, settings: r.settings } : old));
      toast.success(r.secret ? "Sign-up emails are set up. Copy the secret now." : "Saved.");
    },
    onError: (e) => { if (e instanceof ApiError && e.fields) setErrors(e.fields); else showError(e); },
  });
  const regen = useMutation({
    mutationFn: () => api.post<{ settings: Settings; secret: string }>("/auth-email-settings/secret", {}),
    onSuccess: (r) => { setShownSecret(r.secret); setConfirmRegen(false); qc.setQueryData<SettingsResponse>(["auth-email-settings"], (old) => (old ? { ...old, settings: r.settings } : old)); toast.success("New secret made. The old one no longer works."); },
    onError: showError,
  });
  const test = useMutation({
    mutationFn: () => api.post<{ to: string; testSendsLeft: number }>("/auth-email-settings/test", { type }),
    onSuccess: (r) => { toast.success(`Test sent to ${r.to}.`); qc.invalidateQueries({ queryKey: ["auth-email-settings"] }); },
    onError: showError,
  });

  if (q.isPending || !draft) return <Skeleton className="h-64" />;
  const s = q.data?.settings ?? null;
  const senders = q.data?.senders ?? [];
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const setTpl = (key: "templates" | "second", field: keyof Template, value: string) => set({ [key]: { ...draft[key], [type]: { ...(draft[key][type] ?? {}), [field]: value } } } as Partial<Draft>);

  return (
    <div className="space-y-6">
      <Section id="sign-up-emails" title="Sign-up emails" description="Your app's sign-up confirmation, password reset and magic link emails, sent from your own domain with your name, colour and logo.">
        {!senders.length && <p className="mb-4 rounded-lg border border-line bg-elevated px-4 py-3 text-sm text-muted">Add a verified domain and a mailbox such as no-reply@ first. Sign-up emails come from it.</p>}
        {s?.fromAllowed === false && <p role="alert" className="mb-4 rounded-lg bg-warn-soft px-4 py-3 text-sm text-warn">{s.from} still sends your sign-up emails, but it can't be chosen anymore. Only a team mailbox on one of your verified domains can send them, never an AI agent's inbox. Pick a mailbox below and save.</p>}
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-line px-4 py-3">
            <div>
              <p className="text-sm font-medium">Send sign-up emails through Multies</p>
              <p className="text-xs text-subtle">{s ? (s.lastUsedAt ? `Last used ${timeAgo(s.lastUsedAt)}.` : "Not used yet.") : "Not set up yet."} When off, the hook answers with an error and sends nothing.</p>
            </div>
            <Switch checked={draft.enabled} onChange={(v) => set({ enabled: v })} label="Send sign-up emails through Multies" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Sender name" hint={`Shown as the From name. Empty uses ${s?.fromDisplayName ?? "the mailbox name"}.`} error={errors.senderName}>
              {(p) => <Input {...p} value={draft.senderName} maxLength={80} placeholder="Your app" onChange={(e) => set({ senderName: e.target.value })} />}
            </Field>
            <Field label="From address" hint="A mailbox on one of your verified domains." error={errors.from}>
              {(p) => <Select {...p} value={draft.from} onChange={(e) => set({ from: e.target.value })}>{senders.map((m) => <option key={m.address} value={m.address}>{m.address}</option>)}</Select>}
            </Field>
            <Field label="Product name" hint="Fills {appName} in subjects and text." error={errors.appName}>
              {(p) => <Input {...p} value={draft.appName} maxLength={80} placeholder="Your app" onChange={(e) => set({ appName: e.target.value })} />}
            </Field>
            <Field label="Auth project URL" hint="Your sign in service's project address. The links in the emails point there." error={errors.supabaseUrl}>
              {(p) => <Input {...p} value={draft.supabaseUrl} placeholder="https://your-project.example.com" onChange={(e) => set({ supabaseUrl: e.target.value })} />}
            </Field>
            <Field label="Brand colour" hint="For the button. A hex value such as #0071E3." error={errors.branding}>
              {(p) => (
                <div className="flex items-center gap-2">
                  <input type="color" aria-label="Pick brand colour" value={/^#[0-9a-fA-F]{6}$/.test(draft.brandColor) ? draft.brandColor : "#0071e3"} onChange={(e) => set({ brandColor: e.target.value })} className="h-9 w-10 shrink-0 cursor-pointer rounded-md border border-line bg-transparent" />
                  <Input {...p} value={draft.brandColor} placeholder="#0071E3" onChange={(e) => set({ brandColor: e.target.value })} />
                </div>
              )}
            </Field>
            <Field label="Logo URL" hint="An https link to a PNG or SVG.">
              {(p) => <Input {...p} value={draft.logoUrl} placeholder="https://example.com/logo.png" onChange={(e) => set({ logoUrl: e.target.value })} />}
            </Field>
          </div>
        </div>
      </Section>

      <Section id="sign-up-email-text" title="Email text" description="A subject and an intro line for each email. Use {appName}, {email} and {code}. Empty fields use the standard text.">
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-4">
            <div role="tablist" aria-label="Email type" className="flex flex-wrap gap-1">
              {types.map((t) => (
                <button key={t} role="tab" type="button" aria-selected={t === type} onClick={() => setType(t)}
                  className={cn("rounded-full px-3 py-1.5 text-[13px] transition-colors", t === type ? "bg-brand text-brand-fg" : "bg-fill text-muted hover:text-fg")}>{TYPE_LABEL[t] ?? t}</button>
              ))}
            </div>
            <Field label="Subject">{(p) => <Input {...p} value={draft.templates[type]?.subject ?? ""} maxLength={200} placeholder="Confirm your email for {appName}" onChange={(e) => setTpl("templates", "subject", e.target.value)} />}</Field>
            <Field label="Intro line">{(p) => <Textarea {...p} rows={3} value={draft.templates[type]?.intro ?? ""} maxLength={2000} placeholder="Confirm your email address to finish signing up for {appName}." onChange={(e) => setTpl("templates", "intro", e.target.value)} />}</Field>
            <div className="space-y-3 rounded-lg border border-line p-4">
              <p className="text-sm font-medium">Second language (optional)</p>
              <p className="text-xs text-subtle">Shown under the main text, for example Nepali under English.</p>
              <Field label="Language" hint="A language tag such as ne or hi." error={errors["branding"]}>{(p) => <Input {...p} value={draft.lang} maxLength={16} placeholder="ne" onChange={(e) => set({ lang: e.target.value })} />}</Field>
              <Field label="Subject in this language">{(p) => <Input {...p} value={draft.second[type]?.subject ?? ""} maxLength={200} onChange={(e) => setTpl("second", "subject", e.target.value)} />}</Field>
              <Field label="Text in this language">{(p) => <Textarea {...p} rows={3} value={draft.second[type]?.intro ?? ""} maxLength={2000} onChange={(e) => setTpl("second", "intro", e.target.value)} />}</Field>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!senders.length}>Save</Button>
              <Button variant="outline" onClick={() => test.mutate()} loading={test.isPending} disabled={!s || s.testSendsLeft === 0}><IconSend className="h-4 w-4" />Send test email</Button>
              {s && <span className="text-xs text-subtle">{s.testSendsLeft} of {q.data?.testSendsPerHour} test emails left this hour, sent to you.</span>}
            </div>
          </div>
          <div className="space-y-2" aria-live="polite">
            <p className="flex items-center gap-1.5 text-xs font-medium text-subtle"><IconMail className="h-3.5 w-3.5" />Preview: {TYPE_LABEL[type] ?? type}<span className="ml-auto font-normal">Shown as a light email</span></p>
            {/* R40 (MB-215): the light email sits on an inset surround drawn from theme tokens, dark in dark mode, like a message open in a mail app. */}
            <div className="rounded-xl bg-fill p-3 ring-1 ring-line" data-testid="auth-preview-frame">
            <div className="overflow-hidden rounded-lg border border-line bg-white shadow-card">
              <p data-testid="auth-preview-subject" className="border-b border-line px-4 py-2.5 text-[13px] font-medium text-[#1d1d1f]">{preview?.subject ?? " "}</p>
              <iframe title="Email preview" sandbox="" srcDoc={preview?.html ?? ""} className="h-[420px] w-full bg-white" />
            </div>
            </div>
          </div>
        </div>
      </Section>

      {s && (
        <Section id="sign-up-email-hook" title="Hook endpoint" description="In your sign in service, open its Send Email hook, choose HTTPS and paste the URL and the secret.">
          <div className="space-y-4">
            <Field label="Endpoint URL">{(p) => <div className="flex gap-2"><Input {...p} readOnly value={s.endpointUrl} className="font-mono text-[12.5px]" /><CopyButton value={s.endpointUrl} /></div>}</Field>
            {shownSecret ? (
              <div className="rounded-lg border border-brand/40 bg-brand/5 p-4">
                <p className="mb-2 flex items-center gap-1.5 text-sm font-medium"><IconKey className="h-4 w-4" />Signing secret</p>
                <div className="flex gap-2"><Input readOnly aria-label="Signing secret" value={shownSecret} className="font-mono text-[12.5px]" /><CopyButton value={shownSecret} /></div>
                <p className="mt-2 text-xs text-subtle">Copy it now. It isn't shown again.</p>
              </div>
            ) : (
              <Field label="Signing secret" hint="Only the last 4 characters are shown.">{(p) => <Input {...p} readOnly value={s.secret.masked ?? ""} className="font-mono text-[12.5px]" />}</Field>
            )}
            {confirmRegen ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted">The old secret stops working at once, so update your sign in service right after.</span>
                <Button variant="danger" size="sm" onClick={() => regen.mutate()} loading={regen.isPending}>Make new secret</Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmRegen(false)}>Cancel</Button>
              </div>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setConfirmRegen(true)}><IconRefresh className="h-4 w-4" />Regenerate secret</Button>
            )}
          </div>
        </Section>
      )}
    </div>
  );
}
