import { useEffect, useMemo, useState } from "react";
import { ImportSection, XeroSection } from "./import-section";
import { AiSection } from "./ai-section";
import { SavedRepliesSection } from "./mail/saved-replies";
import { ShareLinksSetting } from "./work/share-sheet"; // R26 (MB-87)
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Download, KeyRound, Plus, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { showError } from "@/web/lib/show-error";
import { api, ApiError } from "@/web/lib/api";
import { authClient, unwrap } from "@/web/lib/auth-client";
import { useConfig, useMe, useOrg, qk } from "@/web/lib/queries";
import { Card, CopyButton, Kbd, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { useUndoSeconds } from "@/web/lib/undo-send";
import { UNDO_SEND_CHOICES } from "@/shared/undo-send";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select } from "@/web/components/ui/input";
import { timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { COUNTRIES, DEFAULT_COUNTRY, DEFAULT_TIMEZONE, LANGUAGES, LOCALE, cleanLocale } from "@/shared/locale";

const TABS = [
  { to: "/app/settings", label: "General", end: true },
  { to: "/app/settings/team", label: "Team" },
  { to: "/app/settings/billing", label: "Billing" },
  { to: "/app/settings/account", label: "Account & security" },
  { to: "/app/settings/notifications", label: "Notifications" },
  { to: "/app/settings/calendar", label: "Calendar" },
  { to: "/app/settings/connections", label: "Connected accounts" },
  { to: "/app/settings/mail", label: "Mail routing" },
  { to: "/app/settings/mail-apps", label: "Mail apps" },
  { to: "/app/settings/developers", label: "Developers" },
  { to: "/app/settings/import", label: "Import" },
];

export function SettingsLayout() {
  const loc = useLocation();
  useEffect(() => { if (loc.hash) setTimeout(() => document.getElementById(loc.hash.slice(1))?.scrollIntoView({ behavior: "smooth" }), 100); }, [loc.hash]);
  return (
    <>
      <PageHeader title="Settings" description="Workspace, team, security and how mail flows." />
      <nav aria-label="Settings" className="-mx-1 mb-6 flex gap-1 overflow-x-auto border-b border-line px-1">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => cn(
            "-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-[13.5px] transition-colors",
            isActive ? "border-brand font-medium text-fg" : "border-transparent text-muted hover:text-fg",
          )}>{t.label}</NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  );
}

export function GeneralSettings() {
  return (
    <div className="space-y-6">
      <PreferencesSection />
      <WorkspaceSection />
      <Section id="share-links" title="Share links" description="Read only links to a doc or a board for people outside the workspace."><ShareLinksSetting /></Section>
      <AiSection />
      <XeroSection />
      <WorkspaceExport />
      <DangerZone />
    </div>
  );
}

export function MailSettings() {
  return (
    <div className="space-y-6">
      <UndoSendSection />
      <SavedRepliesSection Section={Section} />
      <InboundSection />
      <OutboundSection />
      <ImportSection />
    </div>
  );
}

/** How long Send waits before posting, so a message can be taken back. Kept on this device, per browser. */
function UndoSendSection() {
  const [seconds, setSeconds] = useUndoSeconds();
  return (
    <Section id="undo-send" title="Undo send" description={<>After you press Send, Multies holds the message for a few seconds so you can take it back. Press <Kbd>Z</Kbd> or Undo while it counts down. This choice is saved on this device.</>}>
      <div role="radiogroup" aria-label="Undo send window" className="inline-flex rounded-lg bg-fill p-0.5">
        {UNDO_SEND_CHOICES.map((n) => (
          <button key={n} type="button" role="radio" aria-checked={seconds === n} onClick={() => setSeconds(n)}
            className={cn("h-8 min-w-14 rounded-md px-3 text-[13px] transition-colors max-sm:min-h-11", seconds === n ? "bg-elevated font-medium text-fg shadow-sm" : "text-muted hover:text-fg")}>
            {n} seconds
          </button>
        ))}
      </div>
    </Section>
  );
}

/** Owners and admins can take everything with them: settings, members, audit log and mail. */
function WorkspaceExport() {
  const me = useMe();
  const role = me.data?.organization?.role;
  if (role !== "owner" && role !== "admin") return null;
  return (
    <Section title="Export workspace data" description="A ZIP with your settings, members, domains, mailboxes, audit log and every message with its attachments, in JSON and CSV. Large workspaces take a minute.">
      <a href="/api/account/workspace/export" download className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-3 text-sm font-medium hover:bg-hover">
        <Download className="h-4 w-4" aria-hidden />Download ZIP
      </a>
    </Section>
  );
}

function DangerZone() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const del = useMutation({
    mutationFn: () => api.del<{ remaining: boolean }>("/account/workspace", { password }),
    onSuccess: () => { qc.clear(); toast.success("Workspace deleted"); navigate("/app"); },
  });
  if (me.data?.organization?.role !== "owner") return null;
  return (
    <Section title="Danger zone" description="Deleting a workspace removes its domains, mailboxes, mail and members' access. It can't be undone.">
      <Button variant="danger" onClick={() => setOpen(true)}><Trash2 className="h-4 w-4" />Delete workspace</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Delete ${me.data.organization.name}?`} description="Everything in this workspace is permanently deleted for every member."
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button variant="danger" loading={del.isPending} disabled={!password} onClick={() => del.mutate()}>Delete workspace</Button></>}>
        <Field label="Confirm with your password" error={del.error instanceof ApiError ? del.error.message : undefined}>
          {(p) => <Input {...p} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
      </Dialog>
    </Section>
  );
}

export function Section({ id, title, description, children }: { id?: string; title: string; description: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card id={id} className="scroll-mt-6">
      <div className="grid gap-6 p-5 md:grid-cols-[260px_1fr] md:p-6">
        <div><h2 className="text-[15px] font-semibold">{title}</h2><div className="mt-1 text-sm text-muted">{description}</div></div>
        <div className="min-w-0">{children}</div>
      </div>
    </Card>
  );
}

/** The person's own time zone and language. Every date in the app shows in their zone. */
function PreferencesSection() {
  const me = useMe();
  const qc = useQueryClient();
  const own = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [timezone, setTimezone] = useState<string>("");
  const [locale, setLocale] = useState<string>("");
  useEffect(() => {
    if (!me.data) return;
    setTimezone(me.data.user.timezone ?? own ?? me.data.organization?.timezone ?? DEFAULT_TIMEZONE);
    setLocale(me.data.user.locale ?? cleanLocale(navigator.language) ?? "en");
  }, [me.data, own]);
  const zones = useMemo(() => {
    const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [DEFAULT_TIMEZONE];
    return own && all.includes(own) ? [own, ...all.filter((z) => z !== own)] : all;
  }, [own]);
  const names = useMemo(() => { try { return new Intl.DisplayNames([locale || "en", "en"], { type: "language" }); } catch { return null; } }, [locale]);
  const langs = useMemo(() => (LANGUAGES as readonly string[]).includes(locale) || !locale ? [...LANGUAGES] : [locale, ...LANGUAGES], [locale]);
  const m = useMutation({
    mutationFn: () => api.patch("/account/preferences", { timezone, locale }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.me }); toast.success("Saved."); },
    onError: (e) => showError(e),
  });
  const dirty = !!me.data && (timezone !== (me.data.user.timezone ?? "") || locale !== (me.data.user.locale ?? ""));
  return (
    <Section id="preferences" title="Your time zone and language" description="Just for you. Chat, mail, meetings and reminders show in your zone, wherever your team is.">
      {me.isPending ? <Skeleton className="h-10 max-w-md" /> : (
        <form className="grid max-w-xl gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
          <Field label="Your time zone">{(p) => (
            <Select {...p} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
            </Select>
          )}</Field>
          <Field label="Your language" hint="Multies is in English for now. This sets dates and numbers.">{(p) => (
            <Select {...p} value={locale} onChange={(e) => setLocale(e.target.value)}>
              {langs.map((l) => <option key={l} value={l}>{names?.of(l) ?? l}</option>)}
            </Select>
          )}</Field>
          <div className="sm:col-span-2">
            <Button type="submit" variant="secondary" loading={m.isPending} disabled={!dirty}>Save</Button>
          </div>
        </form>
      )}
    </Section>
  );
}

function WorkspaceSection() {
  const org = useOrg();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState<string>(DEFAULT_TIMEZONE);
  const [country, setCountry] = useState<string>(DEFAULT_COUNTRY);
  useEffect(() => {
    if (!org.data) return;
    setName(org.data.organization.name);
    setTimezone(org.data.organization.timezone);
    setCountry(org.data.organization.country);
  }, [org.data]);
  const zones = useMemo(() => {
    const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [DEFAULT_TIMEZONE];
    // The browser's own zone first, then every zone.
    const own = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return own && all.includes(own) ? [own, ...all.filter((z) => z !== own)] : all;
  }, []);
  const regionName = useMemo(() => new Intl.DisplayNames([LOCALE], { type: "region" }), []);
  const o = org.data?.organization;
  const dirty = !!o && (name !== o.name || timezone !== o.timezone || country !== o.country);
  const m = useMutation({
    mutationFn: () => api.patch("/org", { name, timezone, country }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.org }); qc.invalidateQueries({ queryKey: qk.me }); toast.success("Workspace saved"); },
    onError: (e) => showError(e),
  });
  return (
    <Section title="Workspace" description="The name your team sees, and where dates and billing default to.">
      {org.isPending ? <Skeleton className="h-10 max-w-md" /> : (
        <form className="grid max-w-xl gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
          <Field label="Workspace name" className="sm:col-span-2">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />}</Field>
          <Field label="Time zone">{(p) => (
            <Select {...p} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
            </Select>
          )}</Field>
          <Field label="Country">{(p) => (
            <Select {...p} value={country} onChange={(e) => setCountry(e.target.value)}>
              {[...COUNTRIES].map((c) => ({ c, n: regionName.of(c) ?? c })).sort((a, b) => a.n.localeCompare(b.n)).map(({ c, n }) => <option key={c} value={c}>{n}</option>)}
            </Select>
          )}</Field>
          <div className="sm:col-span-2">
            <Button type="submit" variant="secondary" loading={m.isPending} disabled={!name.trim() || !dirty}>Save</Button>
          </div>
        </form>
      )}
    </Section>
  );
}

interface InboundKey { id: string; createdAt: string; lastUsedAt: string | null }

function InboundSection() {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ["inbound-keys"], queryFn: async () => (await api.get<{ keys: InboundKey[] }>("/inbound-keys")).keys });
  const [created, setCreated] = useState<{ id: string; secret: string; webhookUrl: string } | null>(null);
  const create = useMutation({
    mutationFn: () => api.post<{ key: { id: string; secret: string }; webhookUrl: string }>("/inbound-keys"),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["inbound-keys"] }); setCreated({ ...r.key, webhookUrl: r.webhookUrl }); },
    onError: (e) => showError(e),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/inbound-keys/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["inbound-keys"] }); toast.success("Key revoked"); },
    onError: (e) => showError(e),
  });
  const webhook = `${window.location.origin}/api/inbound/cloudflare`;
  return (
    <Section id="inbound" title="Inbound mail" description={<>Cloudflare Email Routing receives your mail and a small Email Worker delivers it here, signed with one of these keys.</>}>
      <ol className="space-y-4 text-sm">
        <Step n={1} title="Point your domain at Cloudflare Email Routing">Add the domain to Cloudflare and enable <b className="font-medium">Email → Email Routing</b>. Your domain page will show the MX and SPF checks turn green.</Step>
        <Step n={2} title="Create a signing key">
          <div className="mt-2 space-y-2">
            {keys.isPending ? <Skeleton className="h-12" /> : keys.data?.map((k) => (
              <div key={k.id} className="flex items-center justify-between gap-3 border-b border-line py-2.5 last:border-b-0">
                <div className="flex min-w-0 items-center gap-2.5"><KeyRound className="h-4 w-4 shrink-0 text-subtle" /><code className="truncate font-mono text-[12.5px]">{k.id}</code></div>
                <div className="flex shrink-0 items-center gap-3 text-xs text-subtle">
                  <span>{k.lastUsedAt ? `used ${timeAgo(k.lastUsedAt)}` : "never used"}</span>
                  <button onClick={() => revoke.mutate(k.id)} className="rounded p-1 hover:bg-hover hover:text-bad" aria-label={`Revoke ${k.id}`}><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            ))}
            <Button size="sm" variant="secondary" onClick={() => create.mutate()} loading={create.isPending}><Plus className="h-4 w-4" />Create key</Button>
          </div>
        </Step>
        <Step n={3} title="Deploy the Email Worker">
          From the repository's <code className="font-mono text-[12.5px]">email-worker/</code> folder, set the webhook URL and key, then route your catch-all to the worker.
          <pre tabIndex={0} aria-label="Email Worker settings" className="mt-2 overflow-x-auto rounded-lg border border-line bg-bg/60 p-3 font-mono text-[12px] leading-relaxed text-fg/85">{`MYMAIL_WEBHOOK_URL = "${webhook}"
MYMAIL_KEY_ID      = "${keys.data?.[0]?.id ?? "ink_…"}"
npx wrangler deploy
npx wrangler secret put MYMAIL_KEY_SECRET`}</pre>
        </Step>
      </ol>
      <Dialog open={!!created} onClose={() => setCreated(null)} title="Your new signing key" description="Copy the secret now. It won't be shown again."
        footer={<Button onClick={() => setCreated(null)}><Check className="h-4 w-4" />I've saved it</Button>}>
        {created && (
          <div className="space-y-3 text-sm">
            <Secret label="MYMAIL_KEY_ID" value={created.id} />
            <Secret label="MYMAIL_KEY_SECRET" value={created.secret} />
            <Secret label="MYMAIL_WEBHOOK_URL" value={webhook} />
          </div>
        )}
      </Dialog>
    </Section>
  );
}

function Secret({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted">{label}</div>
      <div className="flex items-center gap-2 rounded-lg border border-line bg-bg/60 px-3 py-2"><code className="min-w-0 flex-1 break-all font-mono text-[12.5px]">{value}</code><CopyButton value={value} /></div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-line-strong text-[11px] font-semibold text-muted">{n}</span>
      <div className="min-w-0 flex-1"><div className="font-medium">{title}</div><div className="mt-0.5 text-muted">{children}</div></div>
    </li>
  );
}

function OutboundSection() {
  const config = useConfig();
  const live = config.data?.outboundDriver && config.data.outboundDriver !== "log";
  return (
    <Section title="Outbound mail" description="How mail to addresses outside Multies leaves the platform.">
      <div className={cn("flex gap-3 border-l-2 py-1 pl-4 text-sm", live ? "border-ok" : "border-warn")}>
        {live ? <Send className="mt-0.5 h-4 w-4 shrink-0 text-ok" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />}
        <div>
          <div className="font-medium">{live ? "Sending through Resend" : "No email provider connected"}</div>
          <p className="mt-0.5 text-muted">
            {live ? "Resend delivers to outside addresses once your domain is verified with Resend too (it gives you its own SPF and DKIM records). Until then, mail to outside addresses is saved to Sent and marked held in Activity." : "Mail between Multies addresses is delivered instantly. Mail to outside addresses is saved to Sent and logged as queued until the server has an email provider key (RESEND_API_KEY)."}
          </p>
        </div>
      </div>
    </Section>
  );
}

export function AccountSection() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState(false);
  const [confirmPw, setConfirmPw] = useState("");
  const change = useMutation({
    mutationFn: () => unwrap(authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true })),
    onSuccess: () => { setCurrent(""); setNext(""); setFields({}); toast.success("Password changed", { description: "Other devices were signed out." }); },
    onError: (e) => { if (e instanceof ApiError && e.fields) setFields(e.fields); else showError(e); },
  });
  const me = useMe();
  const hasPassword = me.data?.hasPassword !== false;
  const [confirmWord, setConfirmWord] = useState("");
  // Goes through /api/account, which handles password and Auth0 sign ins alike and removes the Auth0 login too.
  const del = useMutation({
    mutationFn: () => api.del("/account", { confirm: "DELETE", password: hasPassword ? confirmPw : undefined }),
    onSuccess: () => { qc.clear(); navigate("/"); toast.success("Your account was deleted"); },
  });
  const delError = del.error instanceof Error ? del.error : null;
  const needsReauth = del.error instanceof ApiError && del.error.code === "reauth_required";
  return (
    <Section title="Password" description="Changing it signs you out on every other device.">
      <form className="max-w-md space-y-3" onSubmit={(e) => { e.preventDefault(); setFields({}); change.mutate(); }}>
        <Field label="Current password" error={fields.currentPassword}>{(p) => <Input {...p} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}</Field>
        <Field label="New password" hint="At least 10 characters." error={fields.newPassword}>{(p) => <Input {...p} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}</Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="secondary" loading={change.isPending} disabled={!current || next.length < 10}>Update password</Button>
        </div>
      </form>
      <div className="mt-6 flex max-w-md flex-col gap-3 border-t border-line pt-6 sm:flex-row sm:items-center sm:justify-between">
        <div><h3 className="text-sm font-medium">Delete account</h3><p className="text-xs text-subtle">Removes you and any workspace where you're the only member, with all its mail.</p></div>
        <Button variant="danger" size="sm" onClick={() => setDeleting(true)}>Delete account</Button>
      </div>
      <Dialog open={deleting} onClose={() => { setDeleting(false); del.reset(); }} title="Delete your account?" description="This permanently deletes your account, and any workspace where you're the only member, with its domains, mailboxes and mail. Download your data first if you want a copy."
        footer={<><Button variant="ghost" onClick={() => { setDeleting(false); del.reset(); }}>Cancel</Button><Button variant="danger" disabled={hasPassword ? !confirmPw : confirmWord !== "DELETE"} loading={del.isPending} onClick={() => del.mutate()} data-testid="delete-account-confirm">Delete forever</Button></>}>
        <div className="space-y-3">
          {delError && (
            <div role="alert" data-testid="delete-account-error" className="rounded-lg border border-bad/25 bg-bad-soft px-3 py-2.5 text-sm text-bad">
              {delError.message}
              {needsReauth && <> <a href="/login?next=/app/settings/account" className="font-medium underline underline-offset-2">Sign in again</a></>}
            </div>
          )}
          {hasPassword
            ? <Field label="Confirm with your password">{(p) => <Input {...p} type="password" autoComplete="current-password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} />}</Field>
            : <Field label="Type DELETE to confirm" hint="You signed in with Multies sign in, so there's no password to enter.">{(p) => <Input {...p} autoComplete="off" autoCapitalize="characters" value={confirmWord} onChange={(e) => setConfirmWord(e.target.value)} />}</Field>}
        </div>
      </Dialog>
    </Section>
  );
}
