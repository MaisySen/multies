/**
 * R77: Settings > Branding (workspace owners and admins) and Settings > Appearance (everyone).
 * Laid out like a theme picker: controls on the left, a live preview of the Multies app on the right that changes
 * as you pick, before anything is saved. Members see the brand read only.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";
import { Button } from "@/web/components/ui/button";
import { Skeleton, Switch } from "@/web/components/ui/misc";
import { useDialogs } from "@/web/components/ui/confirm";
import { IconCheck, IconImage, IconInbox, IconLock, IconMonitor, IconMoon, IconRefresh, IconSearch, IconSparkle, IconTasks, IconToday, IconTrash, IconUpload, IconWarning, IconDocs, IconMail } from "@/web/components/ui/icon";
import { AppearanceControl, useAppearance } from "@/web/components/theme";
import { applyBrand, brandQueryKey, useBranding, type BrandingData } from "@/web/lib/brand";
import { useMe } from "@/web/lib/queries";
import {
  FONTS, LOGO_MAX_BYTES, PRESETS, checkBrand, logoUrl, paletteFromPixels, pickLogo, previewTokens,
  type Appearance, type Brand, type BrandPatch, type Density, type FontId, type LogoKind, type Personal, type Radius,
} from "@/shared/branding";

type Draft = Omit<Brand, "logos">;
const draftOf = (b: Brand): Draft => { const { logos: _l, ...d } = b; return d; };
const same = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

function Panel({ title, description, children, testId }: { title: string; description?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-5" data-testid={testId}>
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      <div className="mt-3.5">{children}</div>
    </section>
  );
}

function Segmented<T extends string>({ value, options, onChange, label, disabled }: { value: T; options: { id: T; label: string; icon?: ReactNode }[]; onChange: (v: T) => void; label: string; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex w-full rounded-lg bg-fill p-0.5 sm:w-auto">
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} disabled={disabled} onClick={() => onChange(o.id)}
          className={cn("inline-flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-[13px] transition-[background,color,box-shadow] duration-150 disabled:opacity-50 sm:flex-none",
            value === o.id ? "bg-surface font-medium text-fg shadow-card" : "text-muted hover:text-fg")}>
          {o.icon}{o.label}
        </button>
      ))}
    </div>
  );
}

/** One theme tile: the brand colour, the accent and (when set) the sidebar colour, with a check when chosen. */
function Swatch({ primary, accent, sidebar, label, selected, onClick, disabled, children }: { primary: string; accent: string; sidebar?: string | null; label: string; selected: boolean; onClick: () => void; disabled?: boolean; children?: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-pressed={selected} aria-label={label} title={label}
      className={cn("group relative flex flex-col items-stretch gap-1.5 rounded-xl p-1 text-left outline-none transition-transform duration-150 focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 enabled:hover:-translate-y-0.5")}>
      <span className={cn("relative block aspect-[4/3] overflow-hidden rounded-[10px] ring-1 ring-line", selected && "ring-2 ring-fg")}>
        {children ?? (
          <span className="absolute inset-0 flex">
            {sidebar && <span className="h-full w-1/4" style={{ background: sidebar }} />}
            <span className="relative flex-1" style={{ background: `linear-gradient(135deg, ${primary} 0%, ${primary} 55%, ${accent} 100%)` }}>
              <span className="absolute bottom-1.5 left-1.5 h-1.5 w-6 rounded-full bg-white/80" />
            </span>
          </span>
        )}
        {selected && <span className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-white text-black shadow"><IconCheck className="h-3.5 w-3.5" /></span>}
      </span>
      <span className="truncate px-0.5 text-[12px] text-muted group-aria-pressed:font-medium group-aria-pressed:text-fg">{label}</span>
    </button>
  );
}

function ColourField({ label, value, onChange, placeholder, allowNone, disabled, testId }: { label: string; value: string | null; onChange: (v: string | null) => void; placeholder: string; allowNone?: boolean; disabled?: boolean; testId?: string }) {
  const [text, setText] = useState(value ?? "");
  useEffect(() => setText(value ?? ""), [value]);
  const commit = (s: string) => { const v = s.trim().toLowerCase(); if (/^#[0-9a-f]{6}$/.test(v)) onChange(v); else if (!v && allowNone) onChange(null); };
  return (
    <div className="flex items-center gap-3" data-testid={testId}>
      <label className="relative grid h-9 w-9 shrink-0 cursor-pointer place-items-center rounded-full ring-1 ring-line-strong" style={{ background: value ?? placeholder }}>
        <span className="sr-only">{label} picker</span>
        <input type="color" value={value ?? placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value.toLowerCase())} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
      </label>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{label}</div>
        <input aria-label={`${label} hex`} value={text} disabled={disabled} placeholder={allowNone ? "None" : placeholder} maxLength={7}
          onChange={(e) => { setText(e.target.value); if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) commit(e.target.value); }} onBlur={(e) => commit(e.target.value)}
          className="mt-0.5 w-28 rounded-md border border-line bg-bg px-2 py-1 font-mono text-[12.5px] uppercase outline-none focus:border-brand disabled:opacity-60" />
      </div>
      {allowNone && value && !disabled && <Button variant="ghost" size="sm" onClick={() => onChange(null)}>Clear</Button>}
    </div>
  );
}

const LOGO_SLOTS: { kind: LogoKind; label: string; hint: string; wide: boolean; dark: boolean }[] = [
  { kind: "mark_light", label: "Square mark", hint: "Light mode", wide: false, dark: false },
  { kind: "mark_dark", label: "Square mark", hint: "Dark mode", wide: false, dark: true },
  { kind: "wide_light", label: "Wide logo", hint: "Light mode", wide: true, dark: false },
  { kind: "wide_dark", label: "Wide logo", hint: "Dark mode", wide: true, dark: true },
];

function LogoSlot({ data, kind, label, hint, wide, dark, canEdit, onChanged }: { data: BrandingData; kind: LogoKind; label: string; hint: string; wide: boolean; dark: boolean; canEdit: boolean; onChanged: (b: Brand) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const v = data.brand.logos[kind];
  const upload = async (f: File) => {
    if (!["image/png", "image/jpeg", "image/webp"].includes(f.type)) { toast.error("Use a PNG, JPEG or WebP image."); return; }
    if (f.size > LOGO_MAX_BYTES) { toast.error("Logos can be up to 512 KB. Try a smaller PNG or WebP."); return; }
    setBusy(true);
    try {
      const res = await fetch(`/api/branding/logo/${kind}`, { method: "PUT", credentials: "same-origin", headers: { "content-type": f.type, "x-multies-upload": "1" }, body: f });
      const j = await res.json().catch(() => null) as { brand?: Brand; error?: { message?: string } } | null;
      if (!res.ok || !j?.brand) throw new Error(j?.error?.message ?? "Couldn't upload the logo. Try again.");
      onChanged(j.brand); toast.success("Logo saved");
    } catch (e) { showError(e as Error); } finally { setBusy(false); if (input.current) input.current.value = ""; }
  };
  const remove = async () => {
    setBusy(true);
    try { const r = await api.del<{ brand: Brand }>(`/branding/logo/${kind}`); onChanged(r.brand); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line p-2.5" data-testid={`logo-${kind}`}>
      <div className={cn("grid shrink-0 place-items-center overflow-hidden rounded-lg border border-line", wide ? "h-12 w-24" : "h-12 w-12", dark ? "bg-[#161618]" : "bg-white")}>
        {v ? <img src={logoUrl(data.orgId, kind, v)} alt={`${label}, ${hint.toLowerCase()}`} className="max-h-full max-w-full object-contain p-1" />
          : <IconImage className={cn("h-5 w-5", dark ? "text-white/40" : "text-black/30")} aria-hidden />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{label}</div>
        <div className="text-[12px] text-subtle">{hint}{wide ? " · about 4:1" : " · square"}</div>
      </div>
      {canEdit && (
        <div className="flex shrink-0 items-center gap-1">
          <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} aria-label={`Upload ${label.toLowerCase()} for ${hint.toLowerCase()}`} />
          <Button variant="secondary" size="sm" loading={busy} onClick={() => input.current?.click()}><IconUpload className="h-4 w-4" />{v ? "Replace" : "Upload"}</Button>
          {v && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void remove()} aria-label={`Remove ${label.toLowerCase()} for ${hint.toLowerCase()}`}><IconTrash className="h-4 w-4" /></Button>}
        </div>
      )}
    </div>
  );
}

/** Reads a logo's pixels in a canvas and returns its main colours. */
async function logoColours(url: string): Promise<string[]> {
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  await img.decode();
  const w = Math.min(96, img.naturalWidth || 96), h = Math.max(1, Math.round((img.naturalHeight / (img.naturalWidth || 1)) * w)) || 96;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];
  ctx.drawImage(img, 0, 0, w, h);
  return paletteFromPixels(ctx.getImageData(0, 0, w, h).data);
}

/** The live preview: a small Multies app frame painted with the draft brand, in light or dark. */
export function BrandPreview({ brand, data, personal, scheme, compact }: { brand: Brand; data?: BrandingData; personal?: Personal | null; scheme: "light" | "dark"; compact?: boolean }) {
  const t = previewTokens(brand, scheme, personal ?? null);
  const mark = data ? pickLogo(brand, "mark", scheme) : null;
  const wide = data ? pickLogo(brand, "wide", scheme) : null;
  const root = { ...t.root, fontFamily: "var(--font-sans)", colorScheme: scheme } as CSSProperties;
  const side = { ...t.sidebar, background: brand.sidebar ?? "var(--color-glass-sidebar)" } as CSSProperties;
  const nav: { label: string; Icon: typeof IconInbox; active?: boolean; n?: number }[] = [
    { label: "Inbox", Icon: IconInbox, active: true, n: 3 }, { label: "Tasks", Icon: IconTasks }, { label: "Docs", Icon: IconDocs }, { label: "Mail", Icon: IconMail },
  ];
  return (
    <div style={root} className="overflow-hidden rounded-2xl border border-line bg-bg text-fg shadow-[var(--shadow-e2)]" data-testid="brand-preview" data-scheme={scheme}>
      <div className={cn("flex", compact ? "h-[300px]" : "h-[420px]")}>
        <div style={side} className="hidden w-[34%] min-w-[128px] shrink-0 flex-col gap-1 border-r border-line p-2.5 text-fg min-[420px]:flex">
          <div className="mb-2 flex h-7 items-center gap-2 px-1">
            {wide && data ? <img src={logoUrl(data.orgId, wide, brand.logos[wide]!)} alt="" className="h-5 max-w-full object-contain" />
              : <>
                {mark && data ? <img src={logoUrl(data.orgId, mark, brand.logos[mark]!)} alt="" className="h-6 w-6 rounded-md object-contain" />
                  : <span className="grid h-6 w-6 place-items-center rounded-md bg-brand text-[11px] font-bold text-brand-fg">M</span>}
                <span className="truncate text-[12.5px] font-semibold">Your company</span>
              </>}
          </div>
          {nav.map(({ label, Icon, active, n }) => (
            <div key={label} className={cn("flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px]", active ? "bg-brand-soft font-medium text-fg" : "text-muted")}>
              <Icon className="h-3.5 w-3.5" aria-hidden />{label}
              {n && <span className="ml-auto rounded-full bg-brand px-1.5 text-[10px] font-semibold leading-4 text-brand-fg">{n}</span>}
            </div>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
            <div className="flex h-7 flex-1 items-center gap-1.5 rounded-md bg-fill px-2 text-[11.5px] text-subtle"><IconSearch className="h-3.5 w-3.5" aria-hidden />Search</div>
            <span className="grid h-7 w-7 place-items-center rounded-full bg-accent text-[10.5px] font-semibold text-accent-fg">AL</span>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-hidden p-3">
            <div className="rounded-xl border border-line bg-surface p-3 shadow-card">
              <div className="text-[13px] font-semibold">Welcome back</div>
              <p className="mt-0.5 text-[11.5px] text-muted">3 new messages and 2 tasks due today. <span className="font-medium text-brand-hover">See all</span></p>
              <div className="mt-2.5 flex gap-2">
                <span className="inline-flex h-7 items-center rounded-lg bg-brand px-2.5 text-[11.5px] font-medium text-brand-fg">New message</span>
                <span className="inline-flex h-7 items-center rounded-lg border border-line bg-surface px-2.5 text-[11.5px] text-fg">Invite</span>
              </div>
            </div>
            <div className="overflow-hidden rounded-xl border border-line bg-surface">
              {[["Priya Shah", "Quote for the new site", true], ["Tom Lee", "Re: Friday plan", false]].map(([who, subject, unread]) => (
                <div key={String(who)} className="flex items-center gap-2 border-b border-line px-3 py-2 last:border-b-0">
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", unread ? "bg-brand" : "bg-transparent")} />
                  <span className={cn("w-20 shrink-0 truncate text-[11.5px]", unread && "font-semibold")}>{who}</span>
                  <span className="min-w-0 truncate text-[11.5px] text-muted">{subject}</span>
                </div>
              ))}
            </div>
            <div className="rounded-xl border border-line bg-surface p-3">
              <div className="flex items-center justify-between text-[11.5px]"><span className="font-medium">Website launch</span><span className="text-subtle">64%</span></div>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-fill"><div className="h-full w-[64%] rounded-full bg-accent" /></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewPane({ brand, data, personal }: { brand: Brand; data?: BrandingData; personal?: Personal | null }) {
  const { resolved } = useAppearance();
  const [scheme, setScheme] = useState<"light" | "dark">(resolved);
  return (
    <div className="space-y-3 xl:sticky xl:top-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold">Theme preview</h2>
        <Segmented label="Preview in" value={scheme} onChange={setScheme} options={[{ id: "light", label: "Light", icon: <IconToday className="h-3.5 w-3.5" /> }, { id: "dark", label: "Dark", icon: <IconMoon className="h-3.5 w-3.5" /> }]} />
      </div>
      <BrandPreview brand={brand} data={data} personal={personal} scheme={scheme} />
      <p className="text-[12px] text-subtle">This is how Multies looks for your team. Nothing changes until you save.</p>
    </div>
  );
}

export function BrandingSettings() {
  const me = useMe();
  const q = useBranding(!!me.data?.organization);
  const qc = useQueryClient();
  const { confirm, dialogs } = useDialogs();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [extracting, setExtracting] = useState(false);
  useEffect(() => { if (q.data && !draft) setDraft(draftOf(q.data.brand)); }, [q.data, draft]);
  const canEdit = !!q.data?.canEdit;
  const saved = q.data ? draftOf(q.data.brand) : null;
  const dirty = !!draft && !!saved && !same(draft, saved);
  const brand: Brand | null = draft && q.data ? { ...draft, logos: q.data.brand.logos } : null;
  const checks = useMemo(() => (brand ? checkBrand(brand) : []), [brand?.primary, brand?.accent, brand?.sidebar]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const onSaved = (r: { brand: Brand; css: string }) => {
    const next = { ...(q.data as BrandingData), brand: r.brand, css: r.css, checks: checkBrand(r.brand) };
    qc.setQueryData(brandQueryKey, next); applyBrand(next); setDraft(draftOf(r.brand));
  };
  const save = useMutation({
    mutationFn: () => { const { primary, accent, sidebar, radius, density, font, appearance, locked, preset } = draft as Draft; return api.put<{ brand: Brand; css: string }>("/branding", { primary, accent, sidebar, radius, density, font, appearance, locked, preset } satisfies BrandPatch); },
    onSuccess: (r) => { onSaved(r); toast.success("Brand saved for everyone in this workspace"); },
    onError: (e) => showError(e),
  });
  const reset = useMutation({
    mutationFn: () => api.del<{ brand: Brand; css: string }>("/branding"),
    onSuccess: (r) => { onSaved(r); toast.success("Back to the Multies look"); },
    onError: (e) => showError(e),
  });
  const logoChanged = (b: Brand) => {
    const next = { ...(q.data as BrandingData), brand: { ...(q.data as BrandingData).brand, logos: b.logos } };
    qc.setQueryData(brandQueryKey, next);
  };
  const takeLogoColours = async () => {
    if (!q.data || !brand) return;
    const kind = pickLogo(brand, "mark", "light") ?? pickLogo(brand, "wide", "light");
    if (!kind) { toast.message("Upload a logo first, then pick its colours."); return; }
    setExtracting(true);
    try {
      const cols = await logoColours(logoUrl(q.data.orgId, kind, brand.logos[kind]!));
      if (!cols.length) { toast.message("That logo has no strong colours to use. Pick one below."); return; }
      set({ primary: cols[0], accent: cols[1] ?? cols[0], preset: "logo" });
      toast.success("Colours taken from your logo");
    } catch { toast.error("Couldn't read the logo's colours."); } finally { setExtracting(false); }
  };
  if (q.isPending || !draft || !brand || !q.data) return <div className="grid gap-4 xl:grid-cols-2"><Skeleton className="h-96" /><Skeleton className="h-96" /></div>;
  const ro = !canEdit;
  const hasLogo = Object.keys(q.data.brand.logos).length > 0;
  const fails = checks.filter((c) => !c.ok);
  return (
    <div className="space-y-4" data-testid="branding-settings">
      {dialogs}
      {ro && <p className="flex items-center gap-2 rounded-xl border border-line bg-fill px-3 py-2 text-[13px] text-muted"><IconLock className="h-4 w-4" aria-hidden />Only workspace owners and admins can change the brand.</p>}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <div className="order-2 space-y-4 xl:order-1">
          <Panel title="Theme" description="Start from a ready made theme, or take the colours from your logo." testId="brand-presets">
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {PRESETS.map((p) => (
                <Swatch key={p.id} primary={p.primary} accent={p.accent} sidebar={p.sidebar} label={p.name} disabled={ro}
                  selected={draft.preset === p.id || (!draft.preset && p.id === "multies" && !draft.primary)}
                  onClick={() => set(p.id === "multies" ? { primary: null, accent: null, sidebar: null, preset: null } : { primary: p.primary, accent: p.accent, sidebar: p.sidebar, preset: p.id })} />
              ))}
              <Swatch primary="#000" accent="#000" label="Use my logo colours" selected={draft.preset === "logo"} disabled={ro || extracting} onClick={() => void takeLogoColours()}>
                <span className="absolute inset-0 grid place-items-center bg-[conic-gradient(from_180deg,#f43f5e,#f59e0b,#22c55e,#06b6d4,#6366f1,#f43f5e)]">
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-white/90 text-black"><IconSparkle className="h-4 w-4" /></span>
                </span>
              </Swatch>
            </div>
            {!hasLogo && <p className="mt-2 text-[12px] text-subtle">Upload a logo below to use its colours.</p>}
          </Panel>

          <Panel title="Logo" description="Shown in the sidebar, on shared links and on Tools results. PNG, JPEG or WebP, up to 512 KB." testId="brand-logos">
            <div className="grid gap-2 sm:grid-cols-2">
              {LOGO_SLOTS.map((s) => <LogoSlot key={s.kind} data={q.data} {...s} canEdit={canEdit} onChanged={logoChanged} />)}
            </div>
          </Panel>

          <Panel title="Colours" description="Text on your colours is picked automatically so it stays readable." testId="brand-colours">
            <div className="grid gap-4 sm:grid-cols-2">
              <ColourField label="Brand colour" value={draft.primary} placeholder="#0066cc" disabled={ro} onChange={(v) => set({ primary: v, preset: null })} testId="brand-primary" />
              <ColourField label="Accent colour" value={draft.accent} placeholder={draft.primary ?? "#0066cc"} allowNone disabled={ro} onChange={(v) => set({ accent: v, preset: null })} testId="brand-accent" />
              <ColourField label="Sidebar colour" value={draft.sidebar} placeholder="#f5f5f7" allowNone disabled={ro} onChange={(v) => set({ sidebar: v, preset: null })} testId="brand-sidebar" />
            </div>
            <div className="mt-4 space-y-1.5" data-testid="brand-contrast">
              {fails.length === 0
                ? <p className="flex items-center gap-1.5 text-[12.5px] text-ok"><IconCheck className="h-4 w-4" aria-hidden />All text on these colours meets WCAG AA.</p>
                : fails.map((c) => (
                  <p key={c.id} className="flex items-start gap-1.5 text-[12.5px] text-warn"><IconWarning className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                    <span>{c.label}: contrast {c.ratio.toFixed(1)} to 1, under the 4.5 AA needs. Multies adjusts the shade so it stays readable.</span></p>
                ))}
            </div>
          </Panel>

          <Panel title="Shape and type" testId="brand-shape">
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[13px] font-medium">Corners</span>
                <Segmented<Radius> label="Corners" value={draft.radius} disabled={ro} onChange={(radius) => set({ radius })} options={[{ id: "sharp", label: "Sharp" }, { id: "default", label: "Default" }, { id: "round", label: "Round" }]} /></div>
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[13px] font-medium">Density</span>
                <Segmented<Density> label="Density" value={draft.density} disabled={ro} onChange={(density) => set({ density })} options={[{ id: "comfortable", label: "Comfortable" }, { id: "compact", label: "Compact" }]} /></div>
              <div>
                <span className="text-[13px] font-medium">Font</span>
                <div role="radiogroup" aria-label="Font" className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {FONTS.map((f) => (
                    <button key={f.id} type="button" role="radio" aria-checked={draft.font === f.id} disabled={ro} onClick={() => set({ font: f.id as FontId })}
                      className={cn("rounded-xl border px-3 py-2 text-left transition-colors disabled:opacity-60", draft.font === f.id ? "border-brand bg-brand-soft" : "border-line hover:border-line-strong")}>
                      <span className="block text-[18px] leading-6" style={{ fontFamily: f.stack }}>Aa</span>
                      <span className="block text-[12px] text-muted">{f.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </Panel>

          <Panel title="For your team" testId="brand-team">
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[13px] font-medium">Default appearance</span>
                <Segmented<Appearance> label="Default appearance" value={draft.appearance} disabled={ro} onChange={(appearance) => set({ appearance })}
                  options={[{ id: "system", label: "System", icon: <IconMonitor className="h-3.5 w-3.5" /> }, { id: "light", label: "Light", icon: <IconToday className="h-3.5 w-3.5" /> }, { id: "dark", label: "Dark", icon: <IconMoon className="h-3.5 w-3.5" /> }]} /></div>
              <p className="-mt-2 text-[12px] text-subtle">People who picked light or dark for themselves keep their choice.</p>
              <div className="flex items-center justify-between gap-3">
                <div><div className="text-[13px] font-medium">Lock the brand</div><div className="text-[12px] text-subtle">Members can't pick their own accent colour.</div></div>
                <Switch checked={draft.locked} disabled={ro} onChange={(locked) => set({ locked })} label="Lock the brand" />
              </div>
            </div>
          </Panel>

          {canEdit && (
            <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-surface/95 p-3 shadow-[var(--shadow-e2)] backdrop-blur max-sm:pb-[max(12px,env(safe-area-inset-bottom))]" data-testid="brand-actions">
              <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>Save brand</Button>
              <Button variant="ghost" disabled={!dirty || save.isPending} onClick={() => saved && setDraft(saved)}>Discard</Button>
              <Button variant="ghost" className="ml-auto" loading={reset.isPending} onClick={async () => {
                if (await confirm({ title: "Reset to the Multies look?", description: "Your colours, corners, font and logos are removed for everyone in this workspace.", confirmLabel: "Reset", tone: "danger" })) reset.mutate();
              }}><IconRefresh className="h-4 w-4" />Reset to Multies default</Button>
              {dirty && <span className="w-full text-[12px] text-subtle sm:hidden">You have changes that are not saved yet.</span>}
            </div>
          )}
        </div>
        <div className="order-1 xl:order-2"><PreviewPane brand={brand} data={q.data} /></div>
      </div>
    </div>
  );
}

/** Settings > Appearance: light, dark or system, and an own accent unless the workspace locked its brand. */
export function AppearanceSettings() {
  const me = useMe();
  const q = useBranding(!!me.data?.organization);
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (p: Personal) => api.put<{ personal: Personal; css: string }>("/branding/me", p),
    onSuccess: (r) => {
      const next = { ...(q.data as BrandingData), personal: r.personal, css: r.css };
      qc.setQueryData(brandQueryKey, next); applyBrand(next);
    },
    onError: (e) => showError(e),
  });
  if (q.isPending || !q.data) return <Skeleton className="h-80" />;
  const d = q.data;
  const p = save.isPending && save.variables ? save.variables : d.personal;
  const locked = d.brand.locked;
  const follow = locked || p.followBrand;
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]" data-testid="appearance-settings">
      <div className="order-2 space-y-4 xl:order-1">
        <Panel title="Light or dark" description="System follows your device. Your workspace may set a default.">
          <AppearanceControl className="w-full sm:w-auto [&>button]:min-h-9 [&>button]:flex-1 [&>button]:justify-center" />
        </Panel>
        <Panel title="Accent colour" description={locked ? "Your workspace admin set one brand for everyone." : "Use your workspace's brand, or pick your own accent."} testId="personal-accent">
          <div className="flex items-center justify-between gap-3">
            <div><div className="text-[13px] font-medium">Follow workspace brand</div><div className="text-[12px] text-subtle">{locked ? "Locked by an admin" : "On by default"}</div></div>
            <Switch checked={follow} disabled={locked || save.isPending} onChange={(v) => save.mutate({ followBrand: v, accent: p.accent ?? PRESETS[3].primary })} label="Follow workspace brand" />
          </div>
          {!follow && (
            <div className="mt-4 grid grid-cols-4 gap-2 sm:grid-cols-6">
              {PRESETS.map((s) => (
                <Swatch key={s.id} primary={s.primary} accent={s.primary} label={s.name} selected={p.accent === s.primary} onClick={() => save.mutate({ followBrand: false, accent: s.primary })} />
              ))}
            </div>
          )}
          {!follow && <div className="mt-3"><ColourField label="Custom accent" value={p.accent} placeholder="#0066cc" onChange={(v) => v && save.mutate({ followBrand: false, accent: v })} /></div>}
        </Panel>
      </div>
      <div className="order-1 xl:order-2"><PreviewPane brand={d.brand} data={d} personal={locked ? null : p} /></div>
    </div>
  );
}
