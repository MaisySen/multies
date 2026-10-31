/** R87: the link in bio editor. Form on the left, a live phone preview on the right (below on phones), one Save. */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { Button } from "@/web/components/ui/button";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { Card, CopyButton, Skeleton, Switch } from "@/web/components/ui/misc";
import { IconArrowDown, IconArrowUp, IconExternalLink, IconPlus, IconTrash, IconEye } from "@/web/components/ui/icon";
import { BIO_ICON_PATHS } from "@/shared/link-icons";
import { BIO_ICONS, MAX_BIO_ITEMS, MAX_SOCIALS, SOCIALS, type BioIcon, type BioPageInfo, type BioSocial, type SocialKind } from "@/shared/links";
import { cn } from "@/web/lib/cn";
import { useBioPage, plainUrl } from "./data";

type Draft = Omit<BioPageInfo, "items"> & { items: (BioPageInfo["items"][number] & { key: string })[] };
const ICON_LABEL: Record<BioIcon, string> = { link: "Link", globe: "Website", mail: "Email", phone: "Phone", calendar: "Calendar", shop: "Shop", doc: "Document", video: "Video", music: "Music", star: "Star", heart: "Heart", map: "Map" };
const ring = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand";
let seq = 0;
const key = () => `k${Date.now().toString(36)}${seq++}`;

function Glyph({ name, size = 20 }: { name: string; size?: number }) {
  const d = BIO_ICON_PATHS[name];
  return d ? <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" aria-hidden><path d={d} /></svg> : null;
}

function inkOn(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const lin = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return 1.05 / (L + 0.05) >= (L + 0.05) / 0.05 ? "#ffffff" : "#111111";
}

/** The same look as the public page (server/services/links/bio.ts renderBio), drawn in React so it follows every keystroke. */
export function BioPreview({ d, dark }: { d: Draft; dark: boolean }) {
  const brand = d.brandColor && /^#[0-9a-f]{6}$/i.test(d.brandColor) ? d.brandColor : "#0066cc";
  const useDark = d.theme === "dark" || (d.theme === "brand" && dark);
  const pal = useDark ? { bg: "#0c0c0d", fg: "#f5f5f7", muted: "#a1a1a6", card: "#1c1c1e", line: "#38383a" } : { bg: "#f5f5f7", fg: "#1d1d1f", muted: "#6e6e73", card: "#ffffff", line: "#d2d2d7" };
  const av = d.avatar === "logo" ? d.logoUrl : d.avatar === "photo" ? d.photoUrl : null;
  const initials = (d.title || "?").split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase();
  const items = d.items.filter((i) => i.on && i.title.trim());
  return (
    <div className="mx-auto w-full max-w-[340px] overflow-hidden rounded-[2rem] border-[6px] border-[#1d1d1f] shadow-xl" data-testid="bio-preview" aria-label="Preview of your page" role="img">
      <div className="h-[560px] overflow-y-auto px-5 pb-6 pt-9 text-center" style={{ background: pal.bg, color: pal.fg }}>
        {d.avatar !== "none" && (av
          ? <img src={av} alt="" className="mx-auto mb-3 h-20 w-20 rounded-full object-cover" style={{ border: `1px solid ${pal.line}`, background: pal.card }} />
          : <div className="mx-auto mb-3 grid h-20 w-20 place-items-center rounded-full text-[26px] font-semibold" style={{ background: brand, color: inkOn(brand) }}>{initials}</div>)}
        <p className="text-[20px] font-semibold leading-tight [overflow-wrap:anywhere]">{d.title || "Your name"}</p>
        {d.bio && <p className="mx-auto mt-1.5 max-w-[260px] whitespace-pre-line text-[14px] [overflow-wrap:anywhere]" style={{ color: pal.muted }}>{d.bio}</p>}
        <ul className="mt-5 space-y-2.5">
          {items.length ? items.map((i) => (
            <li key={i.key} className="flex min-h-12 items-center gap-2.5 rounded-xl px-4 py-2.5 text-[14px] font-semibold" style={{ background: brand, color: inkOn(brand) }}>
              <Glyph name={i.icon} /><span className="mr-5 flex-1 [overflow-wrap:anywhere]">{i.title}</span>
            </li>
          )) : <li className="rounded-xl border border-dashed p-4 text-[13px]" style={{ borderColor: pal.line, color: pal.muted }}>Your links show here</li>}
        </ul>
        {d.socials.length > 0 && <ul className="mt-5 flex flex-wrap justify-center gap-1">{d.socials.map((s, i) => <li key={i} className="grid h-10 w-10 place-items-center"><Glyph name={s.kind} size={22} /></li>)}</ul>}
        <p className="mt-8 text-[12px]" style={{ color: pal.muted }}>Made with Multies</p>
      </div>
    </div>
  );
}

export function BioEditor() {
  const [scope, setScope] = useState<"me" | "workspace">("me");
  const q = useBioPage(scope);
  return (
    <div className="space-y-4 pt-4" data-testid="bio-editor">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="radiogroup" aria-label="Which page" className="inline-flex rounded-lg bg-fill p-0.5">
          {([["me", "My page"], ["workspace", "Workspace page"]] as const).map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={scope === k} onClick={() => setScope(k)} data-testid={`bio-scope-${k}`}
              className={cn("h-8 rounded-md px-3 text-[13px] font-medium transition-colors max-sm:h-10", ring, scope === k ? "bg-surface text-fg shadow-[var(--shadow-e1)]" : "text-muted hover:text-fg")}>{label}</button>
          ))}
        </div>
        {q.data?.page.id && q.data.page.published && (
          <div className="flex flex-wrap gap-2">
            <CopyButton value={q.data.page.url} label="Copy page link" toastText="Page link copied" className="h-8 px-3 text-[13px]" />
            <a href={q.data.page.url} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-md bg-fill px-3 text-[13px] text-muted hover:bg-hover hover:text-fg max-sm:min-h-11"><IconExternalLink className="h-3.5 w-3.5" aria-hidden />Open page</a>
          </div>
        )}
      </div>
      {q.isError ? (
        <Card className="p-6 text-center"><p className="font-medium">Couldn't load the page</p><Button variant="outline" className="mt-3" onClick={() => void q.refetch()}>Try again</Button></Card>
      ) : !q.data ? (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_262px] 2xl:grid-cols-[minmax(0,1fr)_350px]" aria-busy="true"><Skeleton className="h-96 rounded-xl" /><Skeleton className="h-[560px] rounded-[2rem]" /></div>
      ) : <BioForm key={`${scope}:${q.data.page.id ?? "new"}`} page={q.data.page} scope={scope} />}
    </div>
  );
}

function BioForm({ page, scope }: { page: BioPageInfo; scope: "me" | "workspace" }) {
  const qc = useQueryClient();
  const initial = useMemo<Draft>(() => ({ ...page, items: page.items.map((i) => ({ ...i, key: i.id || key() })) }), [page]);
  const [d, setD] = useState<Draft>(initial);
  const [showPreview, setShowPreview] = useState(false);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => { setD(initial); }, [initial]);
  const dirty = JSON.stringify({ ...d, items: d.items.map(({ key: _k, clicks: _c, ...r }) => r) }) !== JSON.stringify({ ...initial, items: initial.items.map(({ key: _k, clicks: _c, ...r }) => r) });
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const setItem = (i: number, patch: Partial<Draft["items"][number]>) => setD((x) => ({ ...x, items: x.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) }));
  const move = (i: number, by: number) => setD((x) => { const items = [...x.items]; const [it] = items.splice(i, 1); items.splice(i + by, 0, it); return { ...x, items }; });
  const setSocial = (i: number, patch: Partial<BioSocial>) => setD((x) => ({ ...x, socials: x.socials.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const save = useMutation({
    mutationFn: (publish?: boolean) => api.put<{ page: BioPageInfo }>(`/links/bio?scope=${scope}`, {
      slug: d.slug, title: d.title, bio: d.bio, avatar: d.avatar, theme: d.theme, published: publish ?? d.published,
      items: d.items.filter((i) => i.title.trim() || i.url.trim()).map(({ id, title, url, icon, on }) => ({ id: id || undefined, title, url, icon, on })),
      socials: d.socials.filter((s) => s.url.trim()),
    }),
    onSuccess: (r) => { qc.setQueryData(["links-bio", scope], r); toast.success(r.page.published ? "Page saved and live" : "Page saved as a draft"); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const ro = !page.canEdit;
  const base = page.url.slice(0, page.url.length - page.slug.length);
  const totalClicks = page.items.reduce((n, i) => n + i.clicks, 0);

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_262px] 2xl:grid-cols-[minmax(0,1fr)_350px]">
      <form className="min-w-0 space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
        {ro && <p className="rounded-lg bg-fill px-3 py-2 text-[13px] text-muted">Only admins can change the workspace page.</p>}
        <fieldset disabled={ro} className="min-w-0 space-y-4">
          <Card className="space-y-4 p-4 sm:p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-[15px] font-semibold">Page</h2>
                {page.id && <p className="text-[12.5px] text-muted">{page.views} {page.views === 1 ? "visit" : "visits"}, {totalClicks} link {totalClicks === 1 ? "click" : "clicks"}</p>}
              </div>
              <label className="flex items-center gap-2 text-[13px] font-medium">{d.published ? "Live" : "Draft"}<Switch checked={d.published} onChange={(v) => set("published", v)} label="Page is live" /></label>
            </div>
            <Field label="Page address">{(fp) => (<>
              <div className="flex min-w-0 items-stretch overflow-hidden rounded-lg border border-line-strong bg-surface focus-within:ring-2 focus-within:ring-brand">
                <span className="flex shrink-0 items-center bg-fill px-3 text-[13px] text-muted max-sm:max-w-[55%] max-sm:truncate">{plainUrl(base)}</span>
                <input {...fp} value={d.slug} onChange={(e) => set("slug", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} aria-label="Page name" maxLength={40} className="h-9 min-w-0 flex-1 bg-transparent px-2.5 text-sm outline-none max-sm:h-11" data-testid="bio-slug" />
              </div>
            </>)}</Field>
            <Field label="Title">{(fp) => (<><Input {...fp} value={d.title} onChange={(e) => set("title", e.target.value)} maxLength={80} data-testid="bio-title" /></>)}</Field>
            <Field label="Bio" hint={`${d.bio.length} of 300`}>{(fp) => (<><Textarea {...fp} value={d.bio} onChange={(e) => set("bio", e.target.value.slice(0, 300))} rows={3} data-testid="bio-text" /></>)}</Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Picture">{(fp) => (<>
                <Select {...fp} value={d.avatar} onChange={(e) => set("avatar", e.target.value as Draft["avatar"])} data-testid="bio-avatar">
                  <option value="logo">{d.logoUrl ? "Workspace logo" : "Workspace initials"}</option>
                  <option value="photo">{d.photoUrl ? "My photo" : "My initials"}</option>
                  <option value="none">No picture</option>
                </Select>
              </>)}</Field>
              <Field label="Look" hint="Automatic follows the visitor's phone. Buttons use your brand colour">{(fp) => (<>
                <Select {...fp} value={d.theme} onChange={(e) => set("theme", e.target.value as Draft["theme"])} data-testid="bio-theme">
                  <option value="brand">Automatic</option>
                  <option value="light">Always light</option>
                  <option value="dark">Always dark</option>
                </Select>
              </>)}</Field>
            </div>
          </Card>

          <Card className="space-y-3 p-4 sm:p-5">
            <div className="flex items-center justify-between gap-2"><h2 className="text-[15px] font-semibold">Links</h2><span className="text-[12.5px] text-muted">{d.items.length} of {MAX_BIO_ITEMS}</span></div>
            {!d.items.length && <p className="text-[13px] text-muted">Add the places you want people to go: your shop, a booking page, a form.</p>}
            <ol className="space-y-2.5" data-testid="bio-items">
              {d.items.map((it, i) => (
                <li key={it.key} className="rounded-xl border border-line p-3" data-testid="bio-item">
                  <div className="flex flex-wrap items-center gap-2">
                    <Select value={it.icon} onChange={(e) => setItem(i, { icon: e.target.value as BioIcon })} aria-label="Icon" className="w-32">
                      {BIO_ICONS.map((k) => <option key={k} value={k}>{ICON_LABEL[k]}</option>)}
                    </Select>
                    <Input value={it.title} onChange={(e) => setItem(i, { title: e.target.value })} placeholder="Button text" aria-label="Button text" maxLength={80} className="min-w-0 flex-1 basis-40" />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Input value={it.url} onChange={(e) => setItem(i, { url: e.target.value })} placeholder="https://example.com" aria-label="Address" inputMode="url" className="min-w-0 flex-1 basis-56" />
                    <div className="flex items-center gap-1">
                      {page.id && it.id && <span className="mr-1 text-[12px] tabular-nums text-muted" aria-label={`${it.clicks} clicks`}>{it.clicks} {it.clicks === 1 ? "click" : "clicks"}</span>}
                      <Switch checked={it.on} onChange={(v) => setItem(i, { on: v })} label={`Show ${it.title || "this link"}`} />
                      <Button size="icon" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up"><IconArrowUp className="h-4 w-4" /></Button>
                      <Button size="icon" variant="ghost" onClick={() => move(i, 1)} disabled={i === d.items.length - 1} aria-label="Move down"><IconArrowDown className="h-4 w-4" /></Button>
                      <Button size="icon" variant="ghost" onClick={() => setD((x) => ({ ...x, items: x.items.filter((_, j) => j !== i) }))} aria-label="Remove link"><IconTrash className="h-4 w-4" /></Button>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
            <Button variant="outline" disabled={d.items.length >= MAX_BIO_ITEMS} onClick={() => setD((x) => ({ ...x, items: [...x.items, { key: key(), id: "", title: "", url: "", icon: "link", on: true, clicks: 0 }] }))} data-testid="bio-add"><IconPlus className="h-4 w-4" />Add link</Button>
          </Card>

          <Card className="space-y-3 p-4 sm:p-5">
            <h2 className="text-[15px] font-semibold">Social profiles</h2>
            <ul className="space-y-2">
              {d.socials.map((s, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2">
                  <Select value={s.kind} onChange={(e) => setSocial(i, { kind: e.target.value as SocialKind })} aria-label="Network" className="w-36">
                    {SOCIALS.map((o) => <option key={o.kind} value={o.kind}>{o.label}</option>)}
                  </Select>
                  <Input value={s.url} onChange={(e) => setSocial(i, { url: e.target.value })} placeholder={SOCIALS.find((o) => o.kind === s.kind)?.hint} aria-label="Profile address" className="min-w-0 flex-1 basis-48" />
                  <Button size="icon" variant="ghost" onClick={() => setD((x) => ({ ...x, socials: x.socials.filter((_, j) => j !== i) }))} aria-label="Remove profile"><IconTrash className="h-4 w-4" /></Button>
                </li>
              ))}
            </ul>
            <Button variant="outline" disabled={d.socials.length >= MAX_SOCIALS} onClick={() => setD((x) => ({ ...x, socials: [...x.socials, { kind: (SOCIALS.find((o) => !x.socials.some((s) => s.kind === o.kind))?.kind ?? "website"), url: "" }] }))}><IconPlus className="h-4 w-4" />Add profile</Button>
          </Card>
        </fieldset>
        {!ro && (
          <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-2 border-t border-line bg-bg/95 px-1 py-3 backdrop-blur max-lg:pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
            <Button type="submit" loading={save.isPending && save.variables === undefined} disabled={!dirty && !!page.id} data-testid="bio-save">Save</Button>
            {!d.published && <Button variant="outline" onClick={() => { set("published", true); save.mutate(true); }} loading={save.isPending && save.variables === true} data-testid="bio-publish">Save and go live</Button>}
            <Button variant="ghost" className="lg:hidden" onClick={() => setShowPreview((v) => !v)} aria-expanded={showPreview}><IconEye className="h-4 w-4" />{showPreview ? "Hide preview" : "Preview"}</Button>
            {dirty && <span className="text-[12.5px] text-muted">Unsaved changes</span>}
          </div>
        )}
      </form>
      <div className={cn("lg:sticky lg:top-2 lg:block lg:self-start", showPreview || ro ? "block" : "hidden")}>
        <div className="mb-2 flex items-center justify-between text-[12.5px] text-muted">
          <span>Preview</span>
          {d.theme === "brand" && <label className="flex items-center gap-2">Dark<Switch checked={dark} onChange={setDark} label="Preview in dark" /></label>}
        </div>
        <div className="lg:[zoom:0.76] 2xl:[zoom:1]"><BioPreview d={d} dark={dark} /></div>
      </div>
    </div>
  );
}
