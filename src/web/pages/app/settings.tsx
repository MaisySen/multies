import { useEffect, useMemo, useState } from "react";
import { ImportSection, XeroSection } from "./import-section";
import { AiSection } from "./ai-section";
import { SavedRepliesSection } from "./mail/saved-replies";
import { ReadStatusSection } from "./mail/splits"; // R31
import { AttachmentIndexSection } from "./attachment-index-settings"; // Tools P2 (17)
import { ShareLinksSetting } from "./work/share-sheet"; // R26 (MB-87)
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconArchive, IconActivity, IconShield, IconBack, IconBell, IconCalendar, IconCheck, IconChevronRight, IconCode, IconCreditCard, IconDownload, IconKey, IconMail, IconMailCheck, IconPlugZap, IconPlus, IconSearch, IconSend, IconShieldCheck, IconChats, IconSliders, IconSmartphone, IconSparkle, IconMoon, IconTeam, IconTrash, IconWarning } from "@/web/components/ui/icon";
import { toast } from "sonner";
import { showError } from "@/web/lib/show-error";
import { api, ApiError } from "@/web/lib/api";
import { authClient, unwrap } from "@/web/lib/auth-client";
import { useConfig, useMe, useOrg, qk } from "@/web/lib/queries";
import { Card, CopyButton, Kbd, PageHeader, Skeleton, Switch } from "@/web/components/ui/misc";
import { useUndoSeconds } from "@/web/lib/undo-send";
import { UNDO_SEND_CHOICES } from "@/shared/undo-send";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select } from "@/web/components/ui/input";
import { timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { SendRulesSettings } from "./tools-automation/rules-section"; // Tools P2
import { COUNTRIES, DEFAULT_COUNTRY, DEFAULT_TIMEZONE, LANGUAGES, LOCALE, cleanLocale } from "@/shared/locale";

/**
 * R38 premium pass 3: settings as a grouped rail (desktop) and a grouped list hub (phone), the way native settings
 * apps do it, instead of 12 tabs in one overflowing row. Every URL is unchanged. The large title names the pane you
 * are on, "Settings" sits above it as the eyebrow, and a search box filters panes by name and by what is inside them.
 * rea: files/teardowns/rea/linear/settings-nav-r38.md.
 */
type Pane = { to: string; label: string; end?: boolean; icon: React.ComponentType<{ className?: string }>; tint: string; keywords: string };
export const SETTINGS_GROUPS: { label: string; items: Pane[] }[] = [
  { label: "Workspace", items: [
    { to: "/app/settings", label: "General", end: true, icon: IconSliders, tint: "#8E8E93", keywords: "time zone language country workspace name logo share links agents keys tools documents export delete workspace" },
    { to: "/app/settings/branding", label: "Branding", icon: IconSparkle, tint: "#FF2D55", keywords: "brand theme logo colours colors company font corners dark light preset accent sidebar" }, // R77
    { to: "/app/settings/team", label: "Team", icon: IconTeam, tint: "#0071E3", keywords: "members invite roles admin agents guests remove" },
    { to: "/app/settings/channels", label: "Chat channels", icon: IconChats, tint: "#25D366", keywords: "whatsapp messenger instagram facebook meta chat channels connect number customers" }, // C1
    { to: "/app/settings/apps", label: "Connections", icon: IconPlugZap, tint: "#5E5CE6", keywords: "apps integrations social media post schedule facebook instagram linkedin pinterest reddit youtube slack notion hubspot connect connected accounts mailbox imap smtp gmail outlook webhooks zapier" }, // R80C; R82F (MB-279): mail accounts and webhooks live here too
    { to: "/app/settings/billing", label: "Billing", icon: IconCreditCard, tint: "#34C759", keywords: "plan invoices card upgrade receipts tax" },
  ] },
  { label: "You", items: [
    { to: "/app/settings/account", label: "Account & security", icon: IconShieldCheck, tint: "#FF9500", keywords: "password two factor passkey sessions devices sign out delete account blocked people" },
    { to: "/app/settings/appearance", label: "Appearance", icon: IconMoon, tint: "#5E5CE6", keywords: "theme dark light system accent colour color personal" }, // R77
    { to: "/app/settings/notifications", label: "Notifications", icon: IconBell, tint: "#FF3B30", keywords: "push email digest quiet hours sounds badges" },
    { to: "/app/settings/calendar", label: "Calendar", icon: IconCalendar, tint: "#FF2D55", keywords: "sync working hours booking events time zone" },
  ] },
  { label: "Mail", items: [
    { to: "/app/settings/mail", label: "Mail routing", icon: IconMail, tint: "#0A84FF", keywords: "inbound outbound forwarding undo send saved replies read status dns" },
    { to: "/app/settings/mail-apps", label: "Mail apps", icon: IconSmartphone, tint: "#32ADE6", keywords: "imap phone desktop app password apple mail" },
    { to: "/app/settings/mail-archive", label: "Archive and retention", icon: IconArchive, tint: "#8E8E93", keywords: "retention keep delete years legal hold ediscovery search export case mbox compliance archive" }, // R111
    { to: "/app/settings/sign-up-emails", label: "Sign-up emails", icon: IconMailCheck, tint: "#AF52DE", keywords: "auth emails branded confirm reset hook secret" },
    { to: "/app/settings/import", label: "Import and export", icon: IconDownload, tint: "#636366", keywords: "import export move data backup download zip csv calendar contacts mail tasks from another app undo" },
  ] },
  { label: "Build", items: [
    { to: "/app/settings/developers", label: "Developers", icon: IconCode, tint: "#1C1C1E", keywords: "api keys scopes mcp webhooks oauth apps tokens" },
  ] },
  // P1 layout: one sidebar. The pages the old Workspace sidebar listed beside Settings are here now.
  { label: "Admin", items: [
    { to: "/app/activity", label: "Activity", icon: IconActivity, tint: "#8E8E93", keywords: "log audit history changes messages who did what" },
    { to: "/app/admin", label: "Operator", icon: IconShield, tint: "#1C1C1E", keywords: "operator platform admin moderation reports" },
  ] },
];
const ALL_PANES = SETTINGS_GROUPS.flatMap((g) => g.items);
export function paneFor(path: string): Pane {
  const clean = path.replace(/\/+$/, "") || "/app/settings";
  return ALL_PANES.find((p) => p.to !== "/app/settings" && (clean === p.to || clean.startsWith(p.to + "/"))) ?? ALL_PANES[0];
}
/** R59: panes tied to a server switch (chat channels, CHAT_CHANNELS) are listed only while it is on. */
export function panesFor(config: { chatChannels?: boolean; mailArchive?: boolean } | undefined): (p: Pane) => boolean {
  return (p) => (p.to !== "/app/settings/channels" || !!config?.chatChannels) && (p.to !== "/app/settings/mail-archive" || !!config?.mailArchive);
}
export function matchPanes(q: string): Pane[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return ALL_PANES;
  return ALL_PANES.filter((p) => { const hay = `${p.label} ${p.keywords}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
}

function Tile({ pane, size = "md" }: { pane: Pane; size?: "sm" | "md" }) {
  const I = pane.icon;
  return (
    <span className={cn("grid shrink-0 place-items-center text-white shadow-[inset_0_0_0_0.5px_rgb(255_255_255/0.18),0_1px_1px_rgb(0_0_0/0.12)]", size === "sm" ? "h-[22px] w-[22px] rounded-[6px] [&_svg]:h-[13px] [&_svg]:w-[13px]" : "h-[29px] w-[29px] rounded-[7px] [&_svg]:h-4 [&_svg]:w-4")} style={{ background: pane.tint }} aria-hidden>
      <I />
    </span>
  );
}

function SettingsSearch({ value, onChange, onEnter }: { value: string; onChange: (v: string) => void; onEnter: () => void }) {
  return (
    <label className="relative block">
      <span className="sr-only">Search settings</span>
      <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
      <input
        type="search" value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onEnter(); } if (e.key === "Escape") onChange(""); }}
        placeholder="Search settings" data-testid="settings-search"
        className="h-8 w-full rounded-lg border border-line bg-fill/60 pl-8 pr-2 text-[13px] outline-none transition-[box-shadow,border-color] duration-150 placeholder:text-subtle focus:border-brand focus:bg-surface focus:shadow-[0_0_0_3px_rgb(0_113_227/0.18)] max-md:h-11 max-md:rounded-xl max-md:text-[16px]"
      />
    </label>
  );
}

export function SettingsLayout() {
  const loc = useLocation();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  useEffect(() => { if (loc.hash) setTimeout(() => document.getElementById(loc.hash.slice(1))?.scrollIntoView({ behavior: "smooth" }), 100); }, [loc.hash]);
  const pane = paneFor(loc.pathname);
  const atHub = (loc.pathname.replace(/\/+$/, "") === "/app/settings") && !loc.hash;
  // R82F (MB-283): the tab title comes from the app shell (pageTitle), the same for every page.
  const config = useConfig();
  const me = useMe();
  const shown = matchPanes(q).filter(panesFor(config.data)).filter((p) => p.to !== "/app/admin" || !!me.data?.user.platformAdmin);
  const groups = SETTINGS_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => shown.includes(i)) })).filter((g) => g.items.length);
  const go = () => { if (shown[0]) { navigate(shown[0].to); setQ(""); } };
  return (
    <div className="md:grid md:grid-cols-[236px_minmax(0,1fr)] md:gap-8 lg:gap-10">
      {/* Desktop: a sticky grouped rail. */}
      <aside className="max-md:hidden">
        <div className="sticky top-4 space-y-4">
          <SettingsSearch value={q} onChange={setQ} onEnter={go} />
          <nav aria-label="Settings" className="space-y-4" data-testid="settings-rail">
            {groups.map((g) => (
              <div key={g.label}>
                <p className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-subtle">{g.label}</p>
                <ul className="space-y-px">
                  {g.items.map((t) => (
                    <li key={t.to}>
                      <NavLink to={t.to} end={t.end} onClick={() => setQ("")} aria-current={pane.to === t.to ? "page" : undefined} className={() => cn(
                        "group flex h-8 items-center gap-2.5 rounded-lg px-2 text-[13.5px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60",
                        pane.to === t.to ? "bg-brand-soft font-medium text-fg shadow-[inset_0_0_0_0.5px_rgb(0_113_227/0.25)]" : "text-muted hover:bg-hover hover:text-fg",
                      )}>
                        <Tile pane={t} size="sm" />
                        <span className="truncate">{t.label}</span>
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {!groups.length && <p className="px-2 text-[13px] text-muted">No setting matches “{q}”.</p>}
          </nav>
        </div>
      </aside>

      <div className="min-w-0">
        {/* Phone: the hub is a grouped list; every pane gets a back row. */}
        {atHub ? (
          <div className="md:hidden">
            <PageHeader title="Settings" />
            <div className="mb-5"><SettingsSearch value={q} onChange={setQ} onEnter={go} /></div>
            <nav aria-label="Settings" className="space-y-6" data-testid="settings-hub">
              {groups.map((g) => (
                <section key={g.label}>
                  <h2 className="mb-1.5 px-4 text-[12.5px] font-medium uppercase tracking-[0.04em] text-subtle">{g.label}</h2>
                  <ul className="overflow-hidden rounded-[14px] border border-line bg-surface shadow-card">
                    {g.items.map((t, i) => (
                      <li key={t.to}>
                        <NavLink to={t.to === "/app/settings" ? "/app/settings/general" : t.to} className="flex min-h-[48px] items-center gap-3 pl-4 pr-3 transition-colors duration-150 active:bg-hover">
                          <Tile pane={t} />
                          <span className={cn("flex min-h-[48px] flex-1 items-center justify-between gap-2 text-[16px]", i > 0 && "border-t border-line")}>
                            <span className="truncate">{t.label}</span>
                            <IconChevronRight className="h-4 w-4 shrink-0 text-subtle" />
                          </span>
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              {!groups.length && <p className="px-4 text-[15px] text-muted">No setting matches “{q}”.</p>}
            </nav>
          </div>
        ) : (
          <NavLink to="/app/settings" end className="mb-2 inline-flex min-h-11 items-center gap-1 text-[16px] text-brand-hover md:hidden" data-testid="settings-back">
            <IconBack className="h-5 w-5" />Settings
          </NavLink>
        )}
        <div className={cn(atHub && "max-md:hidden")}>
          <div className="mb-6 flex items-center gap-3 max-md:mb-4">
            <span className="max-md:hidden"><Tile pane={pane} /></span>
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-brand-hover max-md:hidden">Settings</p>
              <h1 className="large-title" data-testid="settings-title">{pane.label}</h1>
            </div>
          </div>
          <div className="settings-pane"><Outlet /></div>
        </div>
      </div>
    </div>
  );
}

export function GeneralSettings() {
  return (
    <div className="space-y-6">
      <PreferencesSection />
      <WorkspaceSection />
      <Section id="share-links" title="Share links" description="Read only links to a doc or a board for people outside the workspace."><ShareLinksSetting /></Section>
      <AiSection />
      <ToolsSection />
      <AttachmentIndexSection Section={Section} />
      <SendRulesSettings Section={Section} /> {/* Tools P2: auto rules before sending */}
      <XeroSection />
      <WorkspaceExport />
      <DangerZone />
    </div>
  );
}

/** R63: workspace admins turn document Tools off (or back on). Listed only where the deployment has Tools. */
function ToolsSection() {
  const config = useConfig();
  const me = useMe();
  const qc = useQueryClient();
  const on = !!config.data?.tools;
  const q = useQuery({ queryKey: ["tools-settings"], enabled: on, queryFn: () => api.get<{ on: boolean }>("/tools/settings") });
  const m = useMutation({
    mutationFn: (v: boolean) => api.put<{ on: boolean }>("/tools/settings", { on: v }),
    onSuccess: (r) => { qc.setQueryData(["tools-settings"], r); qc.invalidateQueries({ queryKey: ["tools"] }); toast.success(r.on ? "Tools turned on" : "Tools turned off"); },
    onError: (e) => showError(e),
  });
  if (!on) return null;
  const isAdmin = me.data?.organization?.role !== "member";
  return (
    <Section id="tools" title="Tools" description="Compress, merge, convert and the other document tools. Files run through them are processed on our document engine in Singapore and deleted within 1 hour.">
      {q.isPending ? <Skeleton className="h-6 w-64" /> : (
        <div className="space-y-2 text-sm">
          <Switch checked={!!q.data?.on} disabled={!isAdmin || m.isPending} onChange={(v) => m.mutate(v)} label="Let people in this workspace use Tools" />
          {!isAdmin && <p className="text-muted">Only workspace admins can change this.</p>}
        </div>
      )}
    </Section>
  );
}

export function MailSettings() {
  return (
    <div className="space-y-6">
      <UndoSendSection />
      <ReadStatusSection Section={Section} />
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
        <IconDownload className="h-4 w-4" aria-hidden />Download ZIP
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
      <Button variant="danger" onClick={() => setOpen(true)}><IconTrash className="h-4 w-4" />Delete workspace</Button>
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
                <div className="flex min-w-0 items-center gap-2.5"><IconKey className="h-4 w-4 shrink-0 text-subtle" /><code className="truncate font-mono text-[12.5px]">{k.id}</code></div>
                <div className="flex shrink-0 items-center gap-3 text-xs text-subtle">
                  <span>{k.lastUsedAt ? `used ${timeAgo(k.lastUsedAt)}` : "never used"}</span>
                  <button onClick={() => revoke.mutate(k.id)} className="rounded p-1 hover:bg-hover hover:text-bad" aria-label={`Revoke ${k.id}`}><IconTrash className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            ))}
            <Button size="sm" variant="secondary" onClick={() => create.mutate()} loading={create.isPending}><IconPlus className="h-4 w-4" />Create key</Button>
          </div>
        </Step>
        <Step n={3} title="Deploy the Email Worker">
          From the repository's <code className="font-mono text-[12.5px]">email-worker/</code> folder, set the webhook URL and key, then route your catch-all to the worker.
          <pre tabIndex={0} aria-label="Email Worker settings" className="mt-2 overflow-x-auto rounded-lg border border-line bg-bg/60 p-3 font-mono text-[12px] leading-relaxed text-fg/85">{`MULTIES_WEBHOOK_URL = "${webhook}"
MULTIES_KEY_ID      = "${keys.data?.[0]?.id ?? "ink_…"}"
npx wrangler deploy
npx wrangler secret put MULTIES_KEY_SECRET`}</pre>
        </Step>
      </ol>
      <Dialog open={!!created} onClose={() => setCreated(null)} title="Your new signing key" description="Copy the secret now. It won't be shown again."
        footer={<Button onClick={() => setCreated(null)}><IconCheck className="h-4 w-4" />I've saved it</Button>}>
        {created && (
          <div className="space-y-3 text-sm">
            <Secret label="MULTIES_KEY_ID" value={created.id} />
            <Secret label="MULTIES_KEY_SECRET" value={created.secret} />
            <Secret label="MULTIES_WEBHOOK_URL" value={webhook} />
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
        {live ? <IconSend className="mt-0.5 h-4 w-4 shrink-0 text-ok" /> : <IconWarning className="mt-0.5 h-4 w-4 shrink-0 text-warn" />}
        <div>
          <div className="font-medium">{live ? "Sending to outside addresses is on" : "No email provider connected"}</div>
          <p className="mt-0.5 text-muted">
            {live ? "Mail to outside addresses goes out once your domain is verified for sending too (the sending service gives you its own SPF and DKIM records). Until then, mail to outside addresses is saved to Sent and marked held in Activity." : "Mail between Multies addresses is delivered instantly. Mail to outside addresses is saved to Sent and logged as queued until the server has an email provider key."}
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
