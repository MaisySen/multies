/**
 * R100b image links (/app/tools/image-links, feature tools_c2): resize, crop, smart crop and change the format
 * of a workspace image by its link. The source is a mail attachment (?attachment=, from Files or Mail), a doc
 * image (?doc=) or a pasted Multies image address. Settings on the left at 1280, the live preview on the right;
 * stacked on phones with the Copy link button kept in reach.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ToolsFrame } from "@/web/components/tools/tools-frame";
import { Button } from "@/web/components/ui/button";
import { Input, Select } from "@/web/components/ui/input";
import { CopyButton } from "@/web/components/ui/misc";
import {
  DEFAULT_IMAGE_PARAMS, IMAGE_CROPS, IMAGE_FITS, IMAGE_FORMATS, IMAGE_MAX_EDGE, IMAGE_QUALITY, imageLink, readImageAddress,
  type ImageCrop, type ImageFit, type ImageFormat, type ImageParams, type ImageSource,
} from "@/shared/image-links";

const ring = "outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface";
const FIT_LABEL: Record<ImageFit, string> = { inside: "Fit inside", cover: "Fill and crop", contain: "Fit with a border", fill: "Stretch" };
const FIT_LINE: Record<ImageFit, string> = {
  inside: "Keeps the whole picture, never bigger than the original.", cover: "Fills the size exactly and trims the edges.",
  contain: "Keeps the whole picture and pads the rest.", fill: "Fills the size exactly and may squash the picture.",
};
const CROP_LABEL: Record<ImageCrop, string> = { smart: "Smart (the busiest part)", center: "Middle", top: "Top", bottom: "Bottom", left: "Left", right: "Right" };
const FORMAT_LABEL: Record<ImageFormat, string> = { auto: "Same as the original", webp: "WebP (smallest)", jpeg: "JPEG", png: "PNG" };

export const IMAGE_PRESETS: { id: string; label: string; params: Partial<ImageParams> }[] = [
  { id: "thumb", label: "Square thumbnail", params: { w: 320, h: 320, fit: "cover", crop: "smart", fmt: "webp" } },
  { id: "social", label: "Social card 1200 × 630", params: { w: 1200, h: 630, fit: "cover", crop: "smart", fmt: "jpeg" } },
  { id: "avatar", label: "Avatar 256", params: { w: 256, h: 256, fit: "cover", crop: "smart", fmt: "webp" } },
  { id: "web", label: "Web size 1600 wide", params: { w: 1600, h: 0, fit: "inside", fmt: "webp" } },
];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

const clampEdge = (s: string) => { const n = Math.floor(Number(s.replace(/\D/g, "")) || 0); return Math.min(n, IMAGE_MAX_EDGE); };

export function ImageLinksPage() {
  const [sp, setSp] = useSearchParams();
  const fromQuery = useMemo((): { source: ImageSource; id: string } | null => {
    const a = sp.get("attachment"), d = sp.get("doc");
    if (a && /^[A-Za-z0-9_-]{1,80}$/.test(a)) return { source: "file", id: a };
    if (d && /^[A-Za-z0-9_-]{1,80}$/.test(d)) return { source: "doc", id: d };
    return null;
  }, [sp]);
  const [pasted, setPasted] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [p, setP] = useState<ImageParams>({ ...DEFAULT_IMAGE_PARAMS, w: 800, fmt: "webp" });
  const src = fromQuery;
  const debounced = useDebounced(p, 350);
  const link = src ? imageLink(src.source, src.id, debounced) : "";
  const full = link ? `${typeof location !== "undefined" ? location.origin : ""}${link}` : "";
  const [state, setState] = useState<{ loading: boolean; error: string | null; size: string | null }>({ loading: false, error: null, size: null });
  const imgRef = useRef<HTMLImageElement>(null);
  useEffect(() => { if (link) setState({ loading: true, error: null, size: null }); }, [link]);

  const set = (patch: Partial<ImageParams>) => setP((cur) => ({ ...cur, ...patch }));
  const needsBoth = p.fit !== "inside" && !(p.w && p.h);
  const applyPasted = () => {
    const r = readImageAddress(pasted);
    if (!r) { setPasteError("That is not a Multies image address. Use Image link on a picture in Files, Mail or a doc."); return; }
    setPasteError(null);
    if (r.params !== DEFAULT_IMAGE_PARAMS) setP(r.params);
    setSp(r.source === "file" ? { attachment: r.id } : { doc: r.id });
  };
  const onError = async () => {
    let msg = "This picture could not be made. Try another size.";
    try {
      const res = await fetch(link, { credentials: "same-origin" });
      const j = (await res.json()) as { error?: { message?: string } };
      if (j.error?.message) msg = j.error.message;
      if (res.status === 404) msg = "This picture is not in this workspace, or you can't see it.";
    } catch { /* keep the plain sentence */ }
    setState({ loading: false, error: msg, size: null });
  };

  return (
    <ToolsFrame entryKey="image-links" title="Image links" description="Resize, crop and change the format of a picture in this workspace, then copy its link." usage={false} wide testId="image-links-page">
      {!src ? (
        <div className="mx-auto max-w-xl space-y-4 rounded-2xl border border-dashed border-line px-4 py-8 text-center" data-testid="image-links-empty">
          <p className="text-[14.5px] font-semibold">Pick a picture first</p>
          <p className="text-[13.5px] text-muted">Open a picture in <Link to="/app/files" className={`font-medium text-brand underline ${ring}`}>Files</Link> or Mail and choose Image link, or paste the address of a picture from a doc or another image link.</p>
          <form className="flex flex-col gap-2 text-left sm:flex-row" onSubmit={(e) => { e.preventDefault(); applyPasted(); }}>
            <label className="min-w-0 flex-1"><span className="sr-only">Image address</span><Input value={pasted} onChange={(e) => { setPasted(e.target.value); setPasteError(null); }} placeholder="/api/doc-images/…" aria-invalid={!!pasteError} data-testid="image-links-paste" /></label>
            <Button type="submit" data-testid="image-links-use">Use this picture</Button>
          </form>
          {pasteError && <p role="alert" className="text-left text-[13px] text-bad" data-testid="image-links-paste-error">{pasteError}</p>}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <section className="space-y-4 rounded-2xl border border-line bg-surface p-4" aria-labelledby="img-settings">
            <h2 id="img-settings" className="text-[13px] font-semibold text-muted">Settings</h2>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Quick sizes">
              {IMAGE_PRESETS.map((pr) => (
                <button key={pr.id} type="button" onClick={() => setP({ ...DEFAULT_IMAGE_PARAMS, ...pr.params })} className={`rounded-full border border-line px-3 py-1.5 text-[12.5px] font-medium hover:bg-hover ${ring}`} data-testid={`image-preset-${pr.id}`}>{pr.label}</button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1.5"><span className="block text-[13px] font-medium">Width</span><Input inputMode="numeric" value={p.w ? String(p.w) : ""} placeholder="Auto" onChange={(e) => set({ w: clampEdge(e.target.value) })} data-testid="image-w" /></label>
              <label className="space-y-1.5"><span className="block text-[13px] font-medium">Height</span><Input inputMode="numeric" value={p.h ? String(p.h) : ""} placeholder="Auto" onChange={(e) => set({ h: clampEdge(e.target.value) })} data-testid="image-h" /></label>
            </div>
            <label className="block space-y-1.5"><span className="block text-[13px] font-medium">How it fits</span>
              <Select value={p.fit} onChange={(e) => set({ fit: e.target.value as ImageFit })} data-testid="image-fit">
                {IMAGE_FITS.map((f) => <option key={f} value={f}>{FIT_LABEL[f]}</option>)}
              </Select>
              <span className="block text-[12.5px] text-muted">{FIT_LINE[p.fit]}</span>
            </label>
            {needsBoth && <p role="alert" className="text-[13px] text-bad" data-testid="image-needs-both">Type both a width and a height for this fit.</p>}
            {p.fit === "cover" && (
              <label className="block space-y-1.5"><span className="block text-[13px] font-medium">Keep this part</span>
                <Select value={p.crop} onChange={(e) => set({ crop: e.target.value as ImageCrop })} data-testid="image-crop">
                  {IMAGE_CROPS.map((c) => <option key={c} value={c}>{CROP_LABEL[c]}</option>)}
                </Select>
              </label>
            )}
            <label className="block space-y-1.5"><span className="block text-[13px] font-medium">Format</span>
              <Select value={p.fmt} onChange={(e) => set({ fmt: e.target.value as ImageFormat })} data-testid="image-fmt">
                {IMAGE_FORMATS.map((f) => <option key={f} value={f}>{FORMAT_LABEL[f]}</option>)}
              </Select>
            </label>
            {p.fmt !== "png" && (
              <label className="block space-y-1.5"><span className="flex items-center justify-between text-[13px] font-medium"><span>Quality</span><span className="text-muted">{p.q}</span></span>
                <input type="range" min={IMAGE_QUALITY.min} max={IMAGE_QUALITY.max} value={p.q} onChange={(e) => set({ q: Number(e.target.value) })} className={`w-full accent-[var(--color-brand,#0A84FF)] ${ring}`} aria-label="Quality" data-testid="image-q" />
              </label>
            )}
            <p className="text-[12.5px] text-muted">The link works for people in this workspace who can see the picture. Each size is made once and kept.</p>
          </section>
          <section className="min-w-0 space-y-3 rounded-2xl border border-line bg-surface p-4" aria-labelledby="img-preview">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="img-preview" className="text-[13px] font-semibold text-muted">Preview{state.size ? ` · ${state.size}` : ""}</h2>
              <Link to="/app/tools/image-links" className={`text-[13px] font-medium text-brand ${ring}`} data-testid="image-links-change">Pick another picture</Link>
            </div>
            <div className="relative flex min-h-64 items-center justify-center overflow-hidden rounded-xl bg-[repeating-conic-gradient(var(--color-fill,#eee)_0_25%,transparent_0_50%)] bg-[length:16px_16px]" aria-live="polite" aria-busy={state.loading}>
              {!needsBoth && link && !state.error && (
                <img ref={imgRef} key={link} src={link} alt="Preview of the changed picture" className="max-h-[60vh] max-w-full object-contain" data-testid="image-preview"
                  onLoad={(e) => setState({ loading: false, error: null, size: `${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}` })} onError={() => void onError()} />
              )}
              {state.loading && !state.error && !needsBoth && <span className="absolute inset-x-0 bottom-2 text-center text-[12.5px] text-muted" data-testid="image-loading">Making this size</span>}
              {state.error && <p role="alert" className="px-4 text-center text-[13px] text-bad" data-testid="image-error">{state.error}</p>}
            </div>
            <div className="sticky bottom-2 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface/95 p-2 backdrop-blur">
              <code className="min-w-0 flex-1 truncate rounded-lg bg-fill/60 px-2 py-1.5 font-mono text-[12.5px]" data-testid="image-link">{needsBoth ? "Type both sizes" : link}</code>
              <CopyButton value={full} label="Copy link" />
              <a href={link} download className={`inline-flex h-9 items-center rounded-lg border border-line px-3 text-[13px] font-medium hover:bg-hover ${ring}`} aria-disabled={needsBoth} data-testid="image-download">Download</a>
            </div>
          </section>
        </div>
      )}
    </ToolsFrame>
  );
}
