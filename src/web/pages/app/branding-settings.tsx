/**
 * R77: Settings > Branding (workspace owners and admins) and Settings > Appearance (everyone).
 * R77B (owner feedback "didn't work, bad layout, not interactive"): the page now uses the full width with the
 * settings form on the left and a live preview on the right that stays in view; every choice paints the whole app
 * at once for the admin (others see it after Save); a square logo shows in the sidebar; Save and Discard live in a
 * bar at the top of the pane that never covers a field; logo rows never overlap at any width.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";
import { Button } from "@/web/components/ui/button";
import { EmptyState, Skeleton, Switch } from "@/web/components/ui/misc";
import { useDialogs } from "@/web/components/ui/confirm";
import { IconCheck, IconCheckCircle, IconImage, IconInbox, IconLock, IconMonitor, IconMoon, IconRefresh, IconSearch, IconSparkle, IconTasks, IconToday, IconTrash, IconUpload, IconWarning, IconDocs, IconMail } from "@/web/components/ui/icon";
import { AppearanceControl, useAppearance } from "@/web/components/theme";
import { applyBrand, brandQueryKey, paintBrandCss, useBranding, type BrandingData } from "@/web/lib/brand";
import { useMe } from "@/web/lib/queries";
import {
  FONTS, LOGO_MAX_BYTES, PRESETS, brandCss, checkBrand, logoUrl, paletteFromPixels, pickLogo, previewTokens,
  type Appearance, type Brand, type BrandPatch, type Density, type FontId, type LogoKind, type Personal, type Radius,
} from "@/shared/branding";

type Draft = Omit<Brand, "logos">;
const draftOf = (b: Brand): Draft => { const { logos: _l, ...d } = b; return d; };
const same = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

function Panel({ title, description, children, testId, action }: { title: string; description?: ReactNode; children: ReactNode; testId?: string; action?: ReactNode }) {
  return (
    <section className="@container/panel rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-5" data-testid={testId}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
        </div>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Segmented<T extends string>({ value, options, onChange, label, disabled }: { value: T; options: { id: T; label: string; icon?: ReactNode }[]; onChange: (v: T) => void; label: string; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex w-full rounded-lg bg-fill p-0.5 sm:w-auto">
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} disabled={disabled} onClick={() => onChange(o.id)}
          className={cn("inline-flex min-h-9 max-sm:min-h-11 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 text-[13px] outline-none transition-[background,color,box-shadow,transform] duration-150 focus-visible:ring-2 focus-visible:ring-brand active:scale-[0.97] disabled:opacity-50 motion-reduce:transform-none sm:flex-none",
            value === o.id ? "bg-surface font-medium text-fg shadow-card" : "text-muted hover:bg-hover hover:text-fg")}>
          {o.icon}{o.label}
        </button>
      ))}
    </div>
  );
}

/** A labelled row with a value on the right that wraps under the label when the column is narrow. */
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="min-w-0"><div className="text-[13px] font-medium">{label}</div>{hint && <div className="text-[12px] text-subtle">{hint}</div>}</div>
      {children}
    </div>
  );
}

/** A switch row: the whole row is the tap target (44 px tall on phones), not just the small switch. */
function SwitchRow({ label, hint, checked, onChange, disabled, testId }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; testId?: string }) {
  return (
    <label className={cn("-mx-2 flex min-h-11 items-center justify-between gap-3 rounded-lg px-2 py-1 transition-colors duration-150", disabled ? "cursor-default" : "cursor-pointer hover:bg-hover")} data-testid={testId}>
      <span className="min-w-0"><span className="block text-[13px] font-medium">{label}</span>{hint && <span className="block text-[12px] text-subtle">{hint}</span>}</span>
      <Switch checked={checked} disabled={disabled} onChange={onChange} label={label} />
    </label>
  );
}

/** One theme tile: the brand colour, the accent and (when set) the sidebar colour, with a check when chosen. */
function Swatch({ primary, accent, sidebar, label, selected, onClick, disabled, children }: { primary: string; accent: string; sidebar?: string | null; label: string; selected: boolean; onClick: () => void; disabled?: boolean; children?: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-pressed={selected} aria-label={label} title={label}
      className="group relative flex min-w-0 flex-col items-stretch gap-1.5 rounded-xl p-1.5 text-left outline-none transition-[transform,background-color] duration-150 focus-visible:ring-2 focus-visible:ring-brand enabled:hover:bg-hover enabled:active:scale-[0.96] disabled:opacity-50 motion-reduce:transform-none">
      <span className={cn("relative block aspect-[4/3] overflow-hidden rounded-[10px] ring-1 transition-shadow duration-150",
        selected ? "ring-2 ring-brand ring-offset-2 ring-offset-surface" : "ring-line group-enabled:group-hover:ring-line-strong")}>
        {children ?? (
          <span className="absolute inset-0 flex">
            {sidebar && <span className="h-full w-1/4" style={{ background: sidebar }} />}
            <span className="relative flex-1" style={{ background: `linear-gradient(135deg, ${primary} 0%, ${primary} 55%, ${accent} 100%)` }}>
              <span className="absolute bottom-1.5 left-1.5 h-1.5 w-6 rounded-full bg-white/80" />
            </span>
          </span>
        )}
        {selected && <span className="absolute right-1.5 top-1.5 grid h-5 w-5 animate-fade-in place-items-center rounded-full bg-white text-black shadow"><IconCheck className="h-3.5 w-3.5" /></span>}
      </span>
      <span className="line-clamp-2 px-0.5 text-[12px] leading-tight text-muted group-aria-pressed:font-medium group-aria-pressed:text-fg">{label}</span>
    </button>
  );
}

function ColourField({ label, value, onChange, placeholder, allowNone, disabled, testId }: { label: string; value: string | null; onChange: (v: string | null) => void; placeholder: string; allowNone?: boolean; disabled?: boolean; testId?: string }) {
  const [text, setText] = useState(value ?? "");
  useEffect(() => setText(value ?? ""), [value]);
  const commit = (s: string) => { const v = s.trim().toLowerCase(); if (/^#[0-9a-f]{6}$/.test(v)) onChange(v); else if (!v && allowNone) onChange(null); };
  return (
    <div className="flex min-w-0 items-center gap-3" data-testid={testId}>
      <label className={cn("relative grid h-9 w-9 max-sm:h-11 max-sm:w-11 shrink-0 place-items-center rounded-full ring-1 ring-line-strong transition-transform duration-150 focus-within:ring-2 focus-within:ring-brand", !disabled && "cursor-pointer hover:scale-105 motion-reduce:transform-none")} style={{ background: value ?? placeholder }}>
        <span className="sr-only">{label} picker</span>
        <input type="color" value={value ?? placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value.toLowerCase())} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
      </label>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{label}</div>
        <div className="mt-0.5 flex items-center gap-1">
          <input aria-label={`${label} hex`} value={text} disabled={disabled} placeholder={allowNone ? "None" : placeholder} maxLength={7}
            onChange={(e) => { setText(e.target.value); if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) commit(e.target.value); }} onBlur={(e) => commit(e.target.value)}
            className="w-28 rounded-md border border-line bg-bg px-2 py-1 font-mono text-[12.5px] uppercase outline-none transition-colors focus:border-brand focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-60 max-sm:w-32 max-sm:py-2.5 max-sm:text-[16px]" />
          {allowNone && value && !disabled && <Button variant="ghost" size="sm" onClick={() => onChange(null)} aria-label={`Clear ${label.toLowerCase()}`}>Clear</Button>}
        </div>
      </div>
    </div>
  );
}

const LOGO_SLOTS: { kind: LogoKind; label: string; mode: string; help: string; wide: boolean; dark: boolean }[] = [
  { kind: "mark_light", label: "Square logo", mode: "Light mode", help: "Sidebar, workspace menu and small screens.", wide: false, dark: false },
  { kind: "mark_dark", label: "Square logo", mode: "Dark mode", help: "Optional. The light one is used when empty.", wide: false, dark: true },
  { kind: "wide_light", label: "Wide logo", mode: "Light mode", help: "Top of the sidebar and Tools results. About 4 to 1.", wide: true, dark: false },
  { kind: "wide_dark", label: "Wide logo", mode: "Dark mode", help: "Optional. The light one is used when empty.", wide: true, dark: true },
];

type SlotState = { phase: "idle" } | { phase: "uploading" } | { phase: "saved" } | { phase: "error"; message: string; file?: File };

function LogoSlot({ data, kind, label, mode, help, wide, dark, canEdit, onChanged, confirmRemove }: { data: BrandingData; kind: LogoKind; label: string; mode: string; help: string; wide: boolean; dark: boolean; canEdit: boolean; onChanged: (b: Brand) => void; confirmRemove: () => Promise<boolean> }) {
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<SlotState>({ phase: "idle" });
  const [over, setOver] = useState(false);
  const v = data.brand.logos[kind];
  const busy = state.phase === "uploading";
  useEffect(() => { if (state.phase !== "saved") return; const t = setTimeout(() => setState({ phase: "idle" }), 2500); return () => clearTimeout(t); }, [state.phase]);
  const upload = async (f: File) => {
    if (!["image/png", "image/jpeg", "image/webp"].includes(f.type)) { setState({ phase: "error", message: "Use a PNG, JPEG or WebP image." }); return; }
    if (f.size > LOGO_MAX_BYTES) { setState({ phase: "error", message: "Logos can be up to 512 KB. Try a smaller PNG or WebP." }); return; }
    setState({ phase: "uploading" });
    try {
      const res = await fetch(`/api/branding/logo/${kind}`, { method: "PUT", credentials: "same-origin", headers: { "content-type": f.type, "x-multies-upload": "1" }, body: f });
      const j = await res.json().catch(() => null) as { brand?: Brand; error?: { message?: string } } | null;
      if (!res.ok || !j?.brand) throw new Error(j?.error?.message ?? "Couldn't upload the logo.");
      onChanged(j.brand); setState({ phase: "saved" }); toast.success(`${label} saved. It shows across Multies now.`);
    } catch (e) { setState({ phase: "error", message: (e as Error).message || "Couldn't upload the logo.", file: f }); }
    finally { if (input.current) input.current.value = ""; }
  };
  const remove = async () => {
    if (!(await confirmRemove())) return;
    setState({ phase: "uploading" });
    try { const r = await api.del<{ brand: Brand }>(`/branding/logo/${kind}`); onChanged(r.brand); setState({ phase: "idle" }); toast.success(`${label} removed`); }
    catch (e) { setState({ phase: "error", message: (e as Error).message || "Couldn't remove the logo." }); }
  };
  const name = `${label.toLowerCase()} for ${mode.toLowerCase()}`;
  return (
    <li className={cn("flex min-w-0 gap-3 rounded-xl border p-3 transition-colors duration-150", over ? "border-brand bg-brand-soft" : "border-line")} data-testid={`logo-${kind}`} data-state={state.phase}
      onDragOver={canEdit ? (e) => { e.preventDefault(); setOver(true); } : undefined} onDragLeave={() => setOver(false)}
      onDrop={canEdit ? (e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) void upload(f); } : undefined}>
      <div className={cn("relative grid shrink-0 place-items-center overflow-hidden rounded-lg border border-line", wide ? "h-14 w-24" : "h-14 w-14", dark ? "bg-[#161618]" : "bg-white")}>
        {v ? <img src={logoUrl(data.orgId, kind, v)} alt={`${label}, ${mode.toLowerCase()}`} className="max-h-full max-w-full object-contain p-1.5" />
          : <IconImage className={cn("h-5 w-5", dark ? "text-white/40" : "text-black/30")} aria-hidden />}
        {busy && <span className="absolute inset-0 grid place-items-center bg-black/35"><span className="h-5 w-5 animate-spin rounded-full border-2 border-white/40 border-t-white motion-reduce:animate-none" aria-hidden /></span>}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[13px] font-medium">{label}</span>
          <span className="rounded-full bg-fill px-1.5 text-[11px] leading-[18px] text-muted">{mode}</span>
        </div>
        <p className="mt-0.5 text-[12px] leading-snug text-subtle">{help}</p>
        <div aria-live="polite" className="min-h-0">
          {state.phase === "uploading" && <p className="mt-1 text-[12px] text-muted">Uploading…</p>}
          {state.phase === "saved" && <p className="mt-1 flex items-center gap-1 text-[12px] text-ok"><IconCheck className="h-3.5 w-3.5" aria-hidden />Saved</p>}
          {state.phase === "error" && <p className="mt-1 flex items-start gap-1 text-[12px] text-bad" role="alert"><IconWarning className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden /><span>{state.message}</span></p>}
        </div>
        {canEdit && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} aria-label={`Upload ${name}`} />
            {state.phase === "error" && state.file
              ? <Button variant="secondary" size="sm" onClick={() => void upload(state.file!)}><IconRefresh className="h-4 w-4" />Try again</Button>
              : <Button variant="secondary" size="sm" loading={busy} onClick={() => input.current?.click()} aria-label={`${v ? "Replace" : "Upload"} ${name}`}><IconUpload className="h-4 w-4" />{v ? "Replace" : "Upload"}</Button>}
            {state.phase === "error" && state.file && <Button variant="ghost" size="sm" onClick={() => input.current?.click()}>Choose another</Button>}
            {v && state.phase !== "error" && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void remove()} aria-label={`Remove ${name}`}><IconTrash className="h-4 w-4" />Remove</Button>}
          </div>
        )}
      </div>
    </li>
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
export function BrandPreview({ brand, data, personal, scheme, compact, name }: { brand: Brand; data?: BrandingData; personal?: Personal | null; scheme: "light" | "dark"; compact?: boolean; name?: string }) {
  const t = previewTokens(brand, scheme, personal ?? null);
  const mark = data ? pickLogo(brand, "mark", scheme) : null;
  const wide = data ? pickLogo(brand, "wide", scheme) : null;
  const root = { ...t.root, fontFamily: "var(--font-sans)", colorScheme: scheme } as CSSProperties;
  const side = { ...t.sidebar, background: brand.sidebar ?? "var(--color-glass-sidebar)" } as CSSProperties;
  const nav: { label: string; Icon: typeof IconInbox; active?: boolean; n?: number }[] = [
    { label: "Inbox", Icon: IconInbox, active: true, n: 3 }, { label: "Tasks", Icon: IconTasks }, { label: "Docs", Icon: IconDocs }, { label: "Mail", Icon: IconMail },
  ];
  return (
    <div style={root} className="overflow-hidden rounded-2xl border border-line bg-bg text-fg shadow-[var(--shadow-e2)] transition-[background-color,color] duration-200" data-testid="brand-preview" data-scheme={scheme}>
      <div className={cn("flex transition-colors duration-200", compact ? "h-[300px]" : "h-[260px] @min-[640px]:h-[460px]")}>
        <div style={side} className="hidden w-[34%] min-w-[128px] shrink-0 flex-col gap-1 border-r border-line p-2.5 text-fg min-[420px]:flex">
          <div className="mb-2 flex h-7 items-center gap-2 px-1">
            {wide && data ? <img src={logoUrl(data.orgId, wide, brand.logos[wide]!)} alt="" className="h-5 max-w-full object-contain" />
              : <>
                {mark && data ? <img src={logoUrl(data.orgId, mark, brand.logos[mark]!)} alt="" className="h-6 w-6 rounded-md object-contain" />
                  : <span className="grid h-6 w-6 place-items-center rounded-md bg-brand text-[11px] font-bold text-brand-fg">M</span>}
                <span className="truncate text-[12.5px] font-semibold">{name || "Your company"}</span>
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
              <div className="mt-2.5 flex flex-wrap gap-2">
                <span className="inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-lg bg-brand px-2.5 text-[11.5px] font-medium text-brand-fg">New message</span>
                <span className="inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-lg border border-line bg-surface px-2.5 text-[11.5px] text-fg">Invite</span>
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


function PreviewPane({ brand, data, personal, name, caption }: { brand: Brand; data?: BrandingData; personal?: Personal | null; name?: string; caption: ReactNode }) {
  const { resolved } = useAppearance();
  const [scheme, setScheme] = useState<"light" | "dark">(resolved);
  // The preview follows the app when the app switches between light and dark; the toggle still lets you peek.
  useEffect(() => setScheme(resolved), [resolved]);
  return (
    <div className="space-y-3" data-testid="preview-pane">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold">Live preview</h2>
        <Segmented label="Preview in" value={scheme} onChange={setScheme} options={[{ id: "light", label: "Light", icon: <IconToday className="h-3.5 w-3.5" /> }, { id: "dark", label: "Dark", icon: <IconMoon className="h-3.5 w-3.5" /> }]} />
      </div>
      <BrandPreview brand={brand} data={data} personal={personal} scheme={scheme} name={name} />
      <p className="text-[12px] leading-snug text-subtle">{caption}</p>
    </div>
  );
}

/** The bar at the top of the pane: where things stand, and Save and Discard. It sticks below the top edge and never covers a field. */
function ActionBar({ status, children, testId }: { status: ReactNode; children?: ReactNode; testId?: string }) {
  return (
    <div className="sticky top-0 z-20 -mx-1 mb-5 flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-line bg-surface/95 px-3 py-2 shadow-card backdrop-blur max-sm:-mx-0" data-testid={testId}>
      <div className="min-w-0 flex-1 text-[13px]" aria-live="polite">{status}</div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function BrandingSettings() {
  const me = useMe();
  const q = useBranding(!!me.data?.organization);
  const qc = useQueryClient();
  const { confirm, dialogs } = useDialogs();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  useEffect(() => { if (q.data && !draft) setDraft(draftOf(q.data.brand)); }, [q.data, draft]);
  const canEdit = !!q.data?.canEdit;
  const saved = q.data ? draftOf(q.data.brand) : null;
  const dirty = !!draft && !!saved && !same(draft, saved);
  const brand: Brand | null = draft && q.data ? { ...draft, logos: q.data.brand.logos } : null;
  const checks = useMemo(() => (brand ? checkBrand(brand) : []), [brand?.primary, brand?.accent, brand?.sidebar]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: Partial<Draft>) => { setJustSaved(false); setDraft((d) => (d ? { ...d, ...patch } : d)); };

  // Live: while there are changes, the whole app (sidebar, buttons, links) wears them for the admin at once.
  // Leaving the page or Discard puts the saved brand back.
  const draftCss = brand && dirty ? brandCss(brand, null) : null;
  const savedCssRef = useRef<string>("");
  savedCssRef.current = q.data?.css ?? "";
  useEffect(() => { if (draftCss !== null) paintBrandCss(draftCss); else if (q.data) paintBrandCss(q.data.css); }, [draftCss, q.data]);
  useEffect(() => () => paintBrandCss(savedCssRef.current), []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const onSaved = (r: { brand: Brand; css: string }) => {
    const next = { ...(q.data as BrandingData), brand: r.brand, css: r.css, checks: checkBrand(r.brand) };
    qc.setQueryData(brandQueryKey, next); applyBrand(next); setDraft(draftOf(r.brand));
  };
  const save = useMutation({
    mutationFn: () => { const { primary, accent, sidebar, radius, density, font, appearance, locked, preset } = draft as Draft; return api.put<{ brand: Brand; css: string }>("/branding", { primary, accent, sidebar, radius, density, font, appearance, locked, preset } satisfies BrandPatch); },
    onSuccess: (r) => { onSaved(r); setJustSaved(true); toast.success("Brand saved for everyone in this workspace"); },
    onError: (e) => showError(e),
  });
  const reset = useMutation({
    mutationFn: () => api.del<{ brand: Brand; css: string }>("/branding"),
    onSuccess: (r) => { onSaved(r); setJustSaved(true); toast.success("Back to the Multies look"); },
    onError: (e) => showError(e),
  });
  const discard = useCallback(() => { if (saved) { setDraft(saved); toast.message("Changes discarded"); } }, [saved]);
  // Ctrl or Cmd S saves, like a document.
  const saveRef = useRef(() => {});
  saveRef.current = () => { if (dirty && canEdit && !save.isPending) save.mutate(); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") { e.preventDefault(); saveRef.current(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => { if (!justSaved) return; const t = setTimeout(() => setJustSaved(false), 4000); return () => clearTimeout(t); }, [justSaved]);

  const logoChanged = (b: Brand) => {
    const next = { ...(q.data as BrandingData), brand: { ...(q.data as BrandingData).brand, logos: b.logos } };
    qc.setQueryData(brandQueryKey, next);
  };
  const takeLogoColours = async () => {
    if (!q.data || !brand) return;
    const kind = pickLogo(brand, "mark", "light") ?? pickLogo(brand, "wide", "light");
    if (!kind) { toast.message("Upload a logo first, then pick its colours."); document.getElementById("brand-logos")?.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
    setExtracting(true);
    try {
      const cols = await logoColours(logoUrl(q.data.orgId, kind, brand.logos[kind]!));
      if (!cols.length) { toast.message("That logo has no strong colours to use. Pick one below."); return; }
      set({ primary: cols[0], accent: cols[1] ?? cols[0], preset: "logo" });
      toast.success("Colours taken from your logo. Save to keep them.");
    } catch { toast.error("Couldn't read the logo's colours."); } finally { setExtracting(false); }
  };

  if (q.isError) return <EmptyState icon={<IconWarning />} title="Couldn't load the brand" body="Check your connection, then try again." action={<Button variant="secondary" onClick={() => void q.refetch()}><IconRefresh className="h-4 w-4" />Try again</Button>} />;
  if (q.isPending || !draft || !brand || !q.data) {
    return (
      <div className="@container" data-testid="branding-loading">
        <Skeleton className="mb-5 h-14" />
        <div className="grid gap-6 @min-[640px]:grid-cols-[minmax(0,1fr)_minmax(280px,42%)] @min-[960px]:grid-cols-[minmax(0,1fr)_440px]">
          <div className="space-y-4"><Skeleton className="h-56" /><Skeleton className="h-64" /><Skeleton className="h-40" /></div>
          <Skeleton className="h-[460px]" />
        </div>
      </div>
    );
  }
  const ro = !canEdit;
  const hasLogo = Object.keys(q.data.brand.logos).length > 0;
  const fails = checks.filter((c) => !c.ok);
  const orgName = me.data?.organization?.name;
  const status = ro
    ? <span className="flex items-center gap-2 text-muted"><IconLock className="h-4 w-4 shrink-0" aria-hidden />Only workspace owners and admins can change the brand.</span>
    : save.isPending ? <span className="text-muted">Saving…</span>
      : dirty ? <span className="flex items-center gap-2 font-medium"><span className="h-2 w-2 shrink-0 rounded-full bg-warn" aria-hidden /><span className="max-sm:hidden">Unsaved changes</span><span className="sm:hidden">Unsaved</span><span className="font-normal text-subtle max-md:hidden">· you see them now, your team sees them after you save</span></span>
        : justSaved ? <span className="flex items-center gap-1.5 font-medium text-ok"><IconCheckCircle className="h-4 w-4 shrink-0" aria-hidden /><span className="max-sm:hidden">Saved for everyone</span><span className="sm:hidden">Saved</span></span>
          : <span className="flex items-center gap-1.5 text-muted"><IconCheck className="h-4 w-4 shrink-0" aria-hidden /><span className="max-sm:hidden">All changes saved</span><span className="sm:hidden">Saved</span></span>;
  return (
    <div className="@container" data-testid="branding-settings">
      {dialogs}
      <ActionBar status={status} testId="brand-actions">
        {canEdit && <>
          <Button variant="ghost" disabled={!dirty || save.isPending} onClick={discard}>Discard</Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty} title={`Save brand (${isMac() ? "Cmd" : "Ctrl"} S)`}>Save brand</Button>
        </>}
      </ActionBar>
      <div className="grid items-start gap-6 @min-[640px]:grid-cols-[minmax(0,1fr)_minmax(280px,42%)] @min-[960px]:grid-cols-[minmax(0,1fr)_440px] @min-[1200px]:grid-cols-[minmax(0,1fr)_520px]">
        <div className="order-2 min-w-0 space-y-4 @min-[640px]:order-1">
          <Panel title="Theme" description="Pick a ready made theme or take the colours from your logo. The app changes as you click." testId="brand-presets">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-1">
              {PRESETS.map((p) => (
                <Swatch key={p.id} primary={p.primary} accent={p.accent} sidebar={p.sidebar} label={p.name} disabled={ro}
                  selected={draft.preset === p.id || (!draft.preset && p.id === "multies" && !draft.primary)}
                  onClick={() => set(p.id === "multies" ? { primary: null, accent: null, sidebar: null, preset: null } : { primary: p.primary, accent: p.accent, sidebar: p.sidebar, preset: p.id })} />
              ))}
              <Swatch primary="#000" accent="#000" label="Use my logo colours" selected={draft.preset === "logo"} disabled={ro || extracting} onClick={() => void takeLogoColours()}>
                <span className="absolute inset-0 grid place-items-center bg-[conic-gradient(from_180deg,#f43f5e,#f59e0b,#22c55e,#06b6d4,#6366f1,#f43f5e)]">
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-white/90 text-black">{extracting ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-black/20 border-t-black motion-reduce:animate-none" aria-hidden /> : <IconSparkle className="h-4 w-4" />}</span>
                </span>
              </Swatch>
            </div>
            {!hasLogo && <p className="mt-2 text-[12px] text-subtle">Upload a logo below to use its colours.</p>}
          </Panel>

          <div id="brand-logos">
            <Panel title="Logo" description="PNG, JPEG or WebP, up to 512 KB. Drop a file on a row or choose one. Logos save at once." testId="brand-logos">
              <ul className="grid gap-2 @min-[560px]/panel:grid-cols-2">
                {LOGO_SLOTS.map((s) => <LogoSlot key={s.kind} data={q.data} {...s} canEdit={canEdit} onChanged={logoChanged}
                  confirmRemove={() => confirm({ title: `Remove the ${s.label.toLowerCase()} for ${s.mode.toLowerCase()}?`, description: "It is taken off for everyone in this workspace. You can upload it again any time.", confirmLabel: "Remove", tone: "danger" })} />)}
              </ul>
            </Panel>
          </div>

          <Panel title="Colours" description="Text on your colours is picked for you so it stays readable." testId="brand-colours">
            <div className="grid gap-4 @min-[480px]/panel:grid-cols-2 @min-[720px]/panel:grid-cols-3">
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
              <Row label="Corners"><Segmented<Radius> label="Corners" value={draft.radius} disabled={ro} onChange={(radius) => set({ radius })} options={[{ id: "sharp", label: "Sharp" }, { id: "default", label: "Default" }, { id: "round", label: "Round" }]} /></Row>
              <Row label="Density"><Segmented<Density> label="Density" value={draft.density} disabled={ro} onChange={(density) => set({ density })} options={[{ id: "comfortable", label: "Comfortable" }, { id: "compact", label: "Compact" }]} /></Row>
              <div>
                <span className="text-[13px] font-medium">Font</span>
                <div role="radiogroup" aria-label="Font" className="mt-2 grid grid-cols-2 gap-2 @min-[420px]/panel:grid-cols-3 @min-[720px]/panel:grid-cols-6">
                  {FONTS.map((f) => (
                    <button key={f.id} type="button" role="radio" aria-checked={draft.font === f.id} disabled={ro} onClick={() => set({ font: f.id as FontId })}
                      className={cn("min-w-0 rounded-xl border px-3 py-2 text-left outline-none transition-[border-color,background-color,transform] duration-150 focus-visible:ring-2 focus-visible:ring-brand enabled:active:scale-[0.97] disabled:opacity-60 motion-reduce:transform-none", draft.font === f.id ? "border-brand bg-brand-soft" : "border-line enabled:hover:border-line-strong enabled:hover:bg-hover")}>
                      <span className="block text-[18px] leading-6" style={{ fontFamily: f.stack }}>Aa</span>
                      <span className="block truncate text-[12px] text-muted">{f.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </Panel>

          <Panel title="For your team" testId="brand-team">
            <div className="space-y-3">
              <Row label="Default appearance" hint="People who picked light or dark for themselves keep their choice.">
                <Segmented<Appearance> label="Default appearance" value={draft.appearance} disabled={ro} onChange={(appearance) => set({ appearance })}
                  options={[{ id: "system", label: "System", icon: <IconMonitor className="h-3.5 w-3.5" /> }, { id: "light", label: "Light", icon: <IconToday className="h-3.5 w-3.5" /> }, { id: "dark", label: "Dark", icon: <IconMoon className="h-3.5 w-3.5" /> }]} />
              </Row>
              <SwitchRow label="Lock the brand" hint="Members can't pick their own accent colour." checked={draft.locked} disabled={ro} onChange={(locked) => set({ locked })} testId="brand-lock" />
            </div>
          </Panel>

          {canEdit && (
            <Panel title="Start over" testId="brand-reset">
              <Row label="Reset to Multies default" hint="Removes your colours, corners, font and logos for everyone.">
                <Button variant="danger" loading={reset.isPending} onClick={async () => {
                  if (await confirm({ title: "Reset to the Multies look?", description: "Your colours, corners, font and logos are removed for everyone in this workspace.", confirmLabel: "Reset", tone: "danger" })) reset.mutate();
                }}><IconRefresh className="h-4 w-4" />Reset to Multies default</Button>
              </Row>
            </Panel>
          )}
        </div>
        <div className="order-1 min-w-0 @min-[640px]:sticky @min-[640px]:top-[76px] @min-[640px]:order-2">
          <PreviewPane brand={brand} data={q.data} name={orgName} caption={canEdit ? "You see changes across Multies right away. Your team sees them once you save." : "This is how Multies looks in this workspace."} />
        </div>
      </div>
    </div>
  );
}

/** Settings > Appearance: light, dark or system, and an own accent unless the workspace locked its brand. Saves as you pick. */
export function AppearanceSettings() {
  const me = useMe();
  const q = useBranding(!!me.data?.organization);
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (p: Personal) => api.put<{ personal: Personal; css: string }>("/branding/me", p),
    onSuccess: (r) => {
      const next = { ...(q.data as BrandingData), personal: r.personal, css: r.css };
      qc.setQueryData(brandQueryKey, next); applyBrand(next);
      toast.success("Appearance saved");
    },
    onError: (e) => showError(e),
  });
  if (q.isError) return <EmptyState icon={<IconWarning />} title="Couldn't load your appearance" body="Check your connection, then try again." action={<Button variant="secondary" onClick={() => void q.refetch()}><IconRefresh className="h-4 w-4" />Try again</Button>} />;
  if (q.isPending || !q.data) {
    return (
      <div className="@container" data-testid="appearance-loading">
        <div className="grid gap-6 @min-[640px]:grid-cols-[minmax(0,1fr)_minmax(280px,42%)] @min-[960px]:grid-cols-[minmax(0,1fr)_440px]">
          <div className="space-y-4"><Skeleton className="h-28" /><Skeleton className="h-44" /></div>
          <Skeleton className="h-[460px]" />
        </div>
      </div>
    );
  }
  const d = q.data;
  const p = save.isPending && save.variables ? save.variables : d.personal;
  const locked = d.brand.locked;
  const follow = locked || p.followBrand;
  return (
    <div className="@container" data-testid="appearance-settings">
      <div className="grid items-start gap-6 @min-[640px]:grid-cols-[minmax(0,1fr)_minmax(280px,42%)] @min-[960px]:grid-cols-[minmax(0,1fr)_440px] @min-[1200px]:grid-cols-[minmax(0,1fr)_520px]">
        <div className="order-2 min-w-0 space-y-4 @min-[640px]:order-1">
          <Panel title="Light or dark" description="System follows your device. Your workspace may set a default.">
            <AppearanceControl className="w-full sm:w-auto [&>button]:min-h-9 max-sm:[&>button]:min-h-11 [&>button]:flex-1 [&>button]:justify-center" />
          </Panel>
          <Panel title="Accent colour" description={locked ? "Your workspace admin set one brand for everyone." : "Use your workspace's brand, or pick your own accent. Only you see it."} testId="personal-accent">
            <SwitchRow label="Follow workspace brand" hint={locked ? "Locked by an admin" : "On by default"} checked={follow} disabled={locked || save.isPending}
              onChange={(v) => save.mutate({ followBrand: v, accent: p.accent ?? PRESETS[3].primary })} testId="follow-brand" />
            {!follow && (
              <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-1">
                {PRESETS.map((s) => (
                  <Swatch key={s.id} primary={s.primary} accent={s.primary} label={s.name} selected={p.accent === s.primary} onClick={() => save.mutate({ followBrand: false, accent: s.primary })} />
                ))}
              </div>
            )}
            {!follow && <div className="mt-3"><ColourField label="Custom accent" value={p.accent} placeholder="#0066cc" onChange={(v) => v && save.mutate({ followBrand: false, accent: v })} /></div>}
          </Panel>
        </div>
        <div className="order-1 min-w-0 @min-[640px]:sticky @min-[640px]:top-[76px] @min-[640px]:order-2">
          <PreviewPane brand={d.brand} data={d} personal={locked ? null : p} name={me.data?.organization?.name} caption="This is how Multies looks for you. Changes apply as soon as you pick them." />
        </div>
      </div>
    </div>
  );
}
