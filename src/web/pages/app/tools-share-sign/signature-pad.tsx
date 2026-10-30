/**
 * Tools P2 e-sign: adopt a signature by drawing (pointer, smoothed), typing (three script fonts, SIL OFL, in
 * public/fonts/sign) or uploading a picture. makeImage turns it into a PNG sized to a field.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Button } from "@/web/components/ui/button";

export const SIGN_FONTS = [
  { name: "Dancing Script", file: "DancingScript" },
  { name: "Great Vibes", file: "GreatVibes-Regular" },
  { name: "Caveat", file: "Caveat" },
] as const;

export const SIGN_FONT_CSS = SIGN_FONTS.map((f) => `@font-face{font-family:'${f.name}';src:url(/fonts/sign/${f.file}.woff2) format('woff2');font-display:swap}`).join("");

export type FieldKind = "signature" | "initials" | "date";
export interface SignaturePadHandle { ready(): boolean; makeImage(kind: FieldKind, w: number, h: number): string }

type Mode = "draw" | "type" | "upload";

function fitText(g: CanvasRenderingContext2D, c: HTMLCanvasElement, text: string, font: string) {
  let size = c.height * 0.7;
  g.font = `${size}px '${font}'`;
  while (g.measureText(text).width > c.width * 0.94 && size > 8) { size -= 2; g.font = `${size}px '${font}'`; }
  g.fillText(text, (c.width - g.measureText(text).width) / 2, c.height / 2);
}

function drawFit(g: CanvasRenderingContext2D, c: HTMLCanvasElement, src: CanvasImageSource & { width: number; height: number }) {
  const r = Math.min(c.width / src.width, c.height / src.height);
  g.drawImage(src, (c.width - src.width * r) / 2, (c.height - src.height * r) / 2, src.width * r, src.height * r);
}

export const SignaturePad = forwardRef<SignaturePadHandle, { defaultName: string; onChange?: (ready: boolean) => void }>(function SignaturePad({ defaultName, onChange }, ref) {
  const [mode, setMode] = useState<Mode>("draw");
  const [typed, setTyped] = useState(defaultName);
  const [font, setFont] = useState<string>(SIGN_FONTS[0].name);
  const [drawn, setDrawn] = useState(false);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const pts = useRef<{ x: number; y: number }[] | null>(null);

  const reset = () => {
    const c = canvas.current;
    if (!c) return;
    const r = c.getBoundingClientRect(), d = window.devicePixelRatio || 1;
    c.width = Math.round(r.width * d); c.height = Math.round(r.height * d);
    const g = c.getContext("2d")!;
    g.setTransform(d, 0, 0, d, 0, 0); g.lineCap = "round"; g.lineJoin = "round"; g.strokeStyle = "#111"; g.lineWidth = 2.4;
    setDrawn(false);
  };
  useEffect(() => { if (mode === "draw") reset(); }, [mode]);
  const ready = mode === "draw" ? drawn : mode === "type" ? typed.trim().length > 0 : !!image;
  useEffect(() => { onChange?.(ready); }, [ready, onChange]);

  useImperativeHandle(ref, () => ({
    ready: () => ready,
    makeImage(kind, w, h) {
      const c = document.createElement("canvas");
      c.width = Math.max(40, Math.round(w * 3)); c.height = Math.max(20, Math.round(h * 3));
      const g = c.getContext("2d")!;
      g.fillStyle = "#111"; g.textBaseline = "middle";
      if (kind === "date") { fitText(g, c, new Date().toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }), "Helvetica"); return c.toDataURL("image/png"); }
      const name = (mode === "type" ? typed : defaultName).trim();
      if (kind === "initials" && (mode === "type" || (!drawn && !image))) {
        fitText(g, c, name.split(/\s+/).map((p) => p.charAt(0).toUpperCase()).join("").slice(0, 4) || "X", font);
        return c.toDataURL("image/png");
      }
      if (mode === "type") fitText(g, c, name, font);
      else if (mode === "draw" && canvas.current) drawFit(g, c, canvas.current);
      else if (image) drawFit(g, c, Object.assign(image, { width: image.naturalWidth, height: image.naturalHeight }));
      return c.toDataURL("image/png");
    },
  }), [ready, mode, typed, font, defaultName, drawn, image]);

  const pos = (e: React.PointerEvent) => { const r = canvas.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const tab = (m: Mode, label: string) => (
    <button type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
      className={`rounded-lg border px-3 py-1.5 text-sm ${mode === m ? "border-brand bg-brand/5 font-medium" : "border-line hover:bg-hover"}`}>{label}</button>
  );
  return (
    <div className="space-y-3">
      <style>{SIGN_FONT_CSS}</style>
      <div className="flex gap-2" role="tablist" aria-label="How to sign">{tab("draw", "Draw")}{tab("type", "Type")}{tab("upload", "Upload")}</div>
      {mode === "draw" && (
        <div className="space-y-2">
          <canvas ref={canvas} aria-label="Draw your signature here" data-testid="sign-pad"
            className="block h-40 w-full touch-none rounded-xl border border-dashed border-line-strong bg-white"
            onPointerDown={(e) => { canvas.current!.setPointerCapture(e.pointerId); pts.current = [pos(e)]; }}
            onPointerMove={(e) => {
              const p = pts.current;
              if (!p) return;
              p.push(pos(e));
              if (p.length < 3) return;
              const [a, b, c] = p.slice(-3);
              const g = canvas.current!.getContext("2d")!;
              g.beginPath(); g.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2); g.quadraticCurveTo(b.x, b.y, (b.x + c.x) / 2, (b.y + c.y) / 2); g.stroke();
              setDrawn(true);
            }}
            onPointerUp={() => { pts.current = null; }} onPointerCancel={() => { pts.current = null; }} />
          <Button size="sm" variant="ghost" onClick={reset}>Clear</Button>
        </div>
      )}
      {mode === "type" && (
        <div className="space-y-2">
          <input className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-brand" value={typed} maxLength={80} onChange={(e) => setTyped(e.target.value)} aria-label="Your name" />
          <div role="radiogroup" aria-label="Signature style" className="grid gap-2">
            {SIGN_FONTS.map((f) => (
              <button key={f.name} type="button" role="radio" aria-checked={font === f.name} onClick={() => setFont(f.name)}
                className={`truncate rounded-xl border bg-white px-3 py-2 text-left text-3xl text-[#111] ${font === f.name ? "border-brand ring-2 ring-brand/30" : "border-line"}`} style={{ fontFamily: `'${f.name}'` }}>{typed || "Your name"}</button>
            ))}
          </div>
        </div>
      )}
      {mode === "upload" && (
        <label className="block space-y-1 text-[13px] font-medium">A picture of your signature (PNG or JPG)
          <input type="file" accept="image/png,image/jpeg" className="block text-sm" onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const img = new Image();
            img.onload = () => setImage(img);
            img.src = URL.createObjectURL(f);
          }} />
          {image && <img src={image.src} alt="Your signature" className="mt-2 max-h-24 rounded border border-line bg-white p-2" />}
        </label>
      )}
    </div>
  );
});
