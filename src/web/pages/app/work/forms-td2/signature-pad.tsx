/**
 * TD2: a signature, drawn with a mouse, finger or pen, or typed (the keyboard way in). Our own canvas code, no
 * outside script. The result is a PNG on white, handed to `onDone` to upload with the answer.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/web/components/ui/button";
import { Input } from "@/web/components/ui/input";

const HEIGHT = 160;

function drawTyped(canvas: HTMLCanvasElement, name: string) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width, h = canvas.height;
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#111827";
  let size = Math.round(h * 0.42);
  const font = (s: number) => `italic ${s}px "Brush Script MT", "Segoe Script", "Snell Roundhand", cursive, serif`;
  ctx.font = font(size);
  while (size > 12 && ctx.measureText(name).width > w * 0.9) { size -= 2; ctx.font = font(size); }
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(name, w / 2, h / 2);
}

export function SignaturePad({ id, labelledBy, describedBy, disabled, onDone, onClear, signed }: {
  id: string; labelledBy: string; describedBy?: string; disabled?: boolean; signed: boolean;
  onDone: (png: Blob) => void; onClear: () => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [inked, setInked] = useState(false);
  const [typed, setTyped] = useState(false);
  const [name, setName] = useState("");

  // Size the canvas to its box (sharp on high density screens), white underneath.
  useEffect(() => {
    const c = canvas.current, box = wrap.current;
    if (!c || !box) return;
    const size = () => {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(200, box.clientWidth);
      c.width = Math.round(w * ratio); c.height = Math.round(HEIGHT * ratio);
      c.style.width = `${w}px`; c.style.height = `${HEIGHT}px`;
      const ctx = c.getContext("2d");
      if (ctx) { ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height); }
      setInked(false);
    };
    size();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { if (!drawing.current && !signed) size(); }) : null;
    ro?.observe(box);
    return () => ro?.disconnect();
  }, [typed, signed]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height };
  };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    e.preventDefault();
    canvas.current?.setPointerCapture(e.pointerId);
    drawing.current = true; last.current = point(e);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !last.current) return;
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    const p = point(e);
    ctx.strokeStyle = "#111827"; ctx.lineWidth = Math.max(2, (canvas.current!.width / 400) * 1.6); ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(last.current.x, last.current.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last.current = p; setInked(true);
  };
  const up = () => { drawing.current = false; last.current = null; };
  const clear = () => {
    const c = canvas.current, ctx = c?.getContext("2d");
    if (c && ctx) { ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height); }
    setInked(false); setName(""); onClear();
  };
  const use = () => {
    const c = canvas.current;
    if (!c) return;
    if (typed) drawTyped(c, name.trim());
    c.toBlob((b) => { if (b) onDone(b); }, "image/png");
  };
  const ready = typed ? name.trim().length > 1 : inked;

  return (
    <div className="space-y-2" data-testid={`signature-${id}`}>
      <div ref={wrap} className={`overflow-hidden rounded-lg border border-line bg-white ${typed ? "hidden" : ""}`}>
        <canvas ref={canvas} role="img" aria-labelledby={labelledBy} aria-describedby={describedBy}
          aria-label="Signature box. Draw with a mouse or finger, or choose Type your name instead."
          className="block touch-none select-none" style={{ cursor: disabled ? "not-allowed" : "crosshair" }}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={up} />
      </div>
      {typed && (
        <Input aria-labelledby={labelledBy} aria-describedby={describedBy} value={name} maxLength={80} disabled={disabled} autoComplete="name"
          placeholder="Type your full name" onChange={(e) => setName(e.target.value)} data-testid={`signature-typed-${id}`}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && ready) { e.preventDefault(); e.stopPropagation(); use(); } }} />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={use} disabled={disabled || !ready || signed} data-testid={`signature-use-${id}`}>{signed ? "Signed" : "Use this signature"}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={clear} disabled={disabled}>Clear</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => { setTyped(!typed); clear(); }} disabled={disabled} aria-pressed={typed}>
          {typed ? "Draw instead" : "Type your name instead"}
        </Button>
      </div>
    </div>
  );
}
