/**
 * R86 Edit PDF (/app/tools/edit-pdf): one place to change a PDF on the device, nothing uploaded. Pages can be moved,
 * turned and deleted; text typed onto a page; a drawn signature placed; areas blacked out for good (the page is
 * redrawn with the box painted in, so the words under it are gone); a watermark and page numbers added. Saving makes
 * a new PDF and keeps the original as it was.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ToolsFrame } from "@/web/components/tools/tools-frame";
import { sizeLabel, takeCarried } from "@/web/components/tools/tool-directory";
import { Button } from "@/web/components/ui/button";
import { IconArrowDown, IconArrowUp, IconClose, IconDownload, IconRotate, IconTrash, IconUndo, IconUpload } from "@/web/components/ui/icon";
import { useLeaveGuard } from "@/web/components/tools/leave-guard";
import { useDialogs } from "@/web/components/ui/confirm";
import { saveFile } from "@/web/lib/tool-jobs";
import { SignaturePad, SIGN_FONT_CSS, type SignaturePadHandle } from "@/web/pages/app/tools-share-sign/signature-pad";
import type { EditItem, OpenedPdf } from "@/web/lib/convert/pdf-edit";
import { toast } from "sonner";
import { PHONE_PICK, Select } from "@/web/components/ui/input";

const ring = "outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface";
type Tool = "move" | "text" | "sign" | "box";
const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: "move", label: "Select", hint: "Pick a text, signature or box to move it, or press Delete to remove it." },
  { id: "text", label: "Add text", hint: "Tap the page where the text should start, then type." },
  { id: "sign", label: "Sign", hint: "Draw or type your signature below, then tap the page where it goes." },
  { id: "box", label: "Black out", hint: "Drag over what should be hidden. It is removed from the file for good when you save." },
];
type Turn = 0 | 90 | 180 | 270;
let seq = 0;
const nextId = () => `e${Date.now().toString(36)}${(seq++).toString(36)}`;
const loadEdit = () => import("@/web/lib/convert/pdf-edit");

export function EditPdfPage() {
  const [file, setFile] = useState<File | null>(null);
  const [pdf, setPdf] = useState<OpenedPdf | null>(null);
  const [order, setOrder] = useState<number[]>([]);
  const [turn, setTurn] = useState<Record<number, Turn>>({});
  const [items, setItems] = useState<EditItem[]>([]);
  const [tool, setTool] = useState<Tool>("move");
  const [selected, setSelected] = useState<string | null>(null);
  const [textSize, setTextSize] = useState(14);
  const [watermark, setWatermark] = useState("");
  const [numbers, setNumbers] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const [padReady, setPadReady] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<number | null>(null);
  const [saved, setSaved] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [history, setHistory] = useState<{ order: number[]; turn: Record<number, Turn>; items: EditItem[] }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const pad = useRef<SignaturePadHandle>(null);
  const leaveGuard = useLeaveGuard(!!file && !saved, "your changes");
  const { confirm, dialogs } = useDialogs();
  async function closeFile() {
    if (!saved && !(await confirm({ title: "Close this PDF?", description: "Your changes are not saved yet.", confirmLabel: "Close without saving", tone: "danger" }))) return;
    pdf?.close(); setPdf(null); setFile(null);
  }

  const snapshot = () => setHistory((h) => [...h.slice(-29), { order, turn, items }]);
  const undo = () => setHistory((h) => {
    const last = h[h.length - 1];
    if (!last) return h;
    setOrder(last.order); setTurn(last.turn); setItems(last.items); setSelected(null);
    return h.slice(0, -1);
  });

  const open = useCallback(async (f: File) => {
    if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf") { setError(`${f.name} is not a PDF. Edit PDF opens PDF files.`); return; }
    setError(""); setLoading(true);
    try {
      const m = await loadEdit();
      const opened = await m.openForEdit(f);
      setPdf((old) => { old?.close(); return opened; });
      setFile(f); setOrder(opened.pages.map((_, i) => i)); setTurn({}); setItems([]); setHistory([]); setSelected(null); setSaved(true);
    } catch (err) {
      setError((err as Error).message || "This PDF could not be opened.");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { const c = takeCarried(); if (c[0]) void open(c[0]); }, [open]);
  useEffect(() => () => pdf?.close(), [pdf]);

  // Delete removes the picked item; Ctrl Z undoes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !typing) { e.preventDefault(); undo(); }
      else if ((e.key === "Delete" || e.key === "Backspace") && selected && !typing) { e.preventDefault(); removeItem(selected); }
      else if (e.key === "Escape") { setSelected(null); setTool("move"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const changed = () => setSaved(false);
  const addItem = (it: EditItem) => { snapshot(); setItems((cur) => [...cur, it]); setSelected(it.id); changed(); };
  const patchItem = (id: string, p: Partial<EditItem>) => { setItems((cur) => cur.map((i) => (i.id === id ? { ...i, ...p } : i))); changed(); };
  const removeItem = (id: string) => { snapshot(); setItems((cur) => cur.filter((i) => i.id !== id)); setSelected(null); changed(); };
  const movePage = (k: number, by: -1 | 1) => { const j = k + by; if (j < 0 || j >= order.length) return; snapshot(); const n = [...order]; [n[k], n[j]] = [n[j], n[k]]; setOrder(n); changed(); };
  const turnPage = (idx: number) => { snapshot(); setTurn((t) => ({ ...t, [idx]: (((t[idx] ?? 0) + 90) % 360) as Turn })); changed(); };
  const deletePage = (k: number) => {
    if (order.length <= 1) { toast("A PDF needs at least one page."); return; }
    snapshot(); setOrder(order.filter((_, i) => i !== k)); changed();
    toast(`Page deleted`, { action: { label: "Undo", onClick: undo } });
  };

  function useSignature() {
    if (!pad.current?.ready()) return;
    setSignature(pad.current.makeImage("signature", 240, 80));
    toast("Now tap the page where the signature goes.");
  }

  async function save() {
    if (!file || !pdf) return;
    setSaving(0); setError("");
    try {
      const m = await loadEdit();
      const out = await m.applyEdits(file, { order, turn, items: items.filter((i) => i.kind !== "text" || i.text?.trim()), watermark: watermark.trim() || undefined, numbers }, (f) => setSaving(f));
      saveFile(out, out.name);
      setSaved(true);
      toast(`Saved ${out.name} (${sizeLabel(out.size)})`);
    } catch (err) {
      setError((err as Error).message || "The PDF could not be saved. Try again.");
    } finally { setSaving(null); }
  }

  const onDrop = (e: DragEvent) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) void open(f); };
  const boxes = items.filter((i) => i.kind === "box").length;
  const hint = TOOLS.find((t) => t.id === tool)!.hint;

  return (
    <ToolsFrame entryKey="edit-pdf" title="Edit a PDF" description="Move, turn and delete pages, add text, sign, black out, watermark and number pages. It all happens on your device." wide testId="edit-pdf">
      {leaveGuard}
      {dialogs}
      <style>{SIGN_FONT_CSS}</style>
      {!file ? (
        <div onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
          <button type="button" onClick={() => inputRef.current?.click()} data-testid="edit-pdf-drop" disabled={loading}
            className={`flex w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-12 text-center transition-colors ${dragging ? "border-brand bg-brand/5" : "border-line-strong hover:border-brand/60 hover:bg-hover"} ${ring}`}>
            <IconUpload className="h-7 w-7 text-brand" aria-hidden />
            <span className="text-[15px] font-semibold">{loading ? "Opening the PDF" : "Choose a PDF or drop it here"}</span>
            <span className="text-[13px] text-muted">Up to 100 MB and 300 pages. Nothing is uploaded.</span>
          </button>
          <input ref={inputRef} type="file" accept=".pdf,application/pdf" className="sr-only" tabIndex={-1} aria-hidden data-testid="edit-pdf-input"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void open(f); }} />
          {error && <p role="alert" className="mt-3 text-[13px] text-bad" data-testid="edit-pdf-error">{error}</p>}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="sticky top-0 z-10 -mx-1 space-y-3 rounded-2xl border border-line bg-surface/95 p-3 backdrop-blur" data-testid="edit-pdf-toolbar">
            <div className="flex flex-wrap items-center gap-2">
              <div role="radiogroup" aria-label="Tool" className="inline-flex flex-wrap rounded-xl border border-line p-0.5">
                {TOOLS.map((t) => (
                  <button key={t.id} type="button" role="radio" aria-checked={tool === t.id} onClick={() => { setTool(t.id); setSelected(null); }} data-testid={`edit-pdf-tool-${t.id}`}
                    className={`h-9 rounded-[10px] px-3 text-[13.5px] font-medium transition-colors max-sm:min-h-11 ${tool === t.id ? "bg-brand text-brand-fg" : "text-muted hover:text-fg"} ${ring}`}>{t.label}</button>
                ))}
              </div>
              {tool === "text" && (
                <label className="flex items-center gap-2 text-[13px]">Size
                  <Select bare value={textSize} onChange={(e) => setTextSize(Number(e.target.value))} className={`h-9 rounded-lg border border-line bg-surface px-2 ${ring}`} phoneClassName={`${PHONE_PICK} h-11 w-20 pl-3`} data-testid="edit-pdf-text-size">
                    {[10, 12, 14, 18, 24, 32].map((s) => <option key={s} value={s}>{s}</option>)}
                  </Select>
                </label>
              )}
              <div className="ml-auto flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={undo} disabled={!history.length} className="max-sm:min-h-11" data-testid="edit-pdf-undo"><IconUndo className="h-4 w-4" aria-hidden />Undo</Button>
                <Button size="sm" onClick={() => void save()} disabled={saving !== null} className="max-sm:min-h-11" data-testid="edit-pdf-save">
                  <IconDownload className="h-4 w-4" aria-hidden />{saving !== null ? `Saving ${Math.round(saving * 100)}%` : "Save PDF"}
                </Button>
              </div>
            </div>
            <p className="text-[12.5px] text-muted" data-testid="edit-pdf-hint">{hint}</p>
            {tool === "sign" && (
              <div className="max-w-md space-y-2" data-testid="edit-pdf-sign-pad">
                {signature ? (
                  <div className="flex items-center gap-3">
                    <img src={signature} alt="Your signature" className="h-12 rounded-lg border border-line bg-white px-2" />
                    <Button size="sm" variant="outline" onClick={() => setSignature(null)} className="max-sm:min-h-11">Change</Button>
                  </div>
                ) : (
                  <>
                    <SignaturePad ref={pad} defaultName="" onChange={setPadReady} />
                    <Button size="sm" onClick={useSignature} disabled={!padReady} className="max-sm:min-h-11" data-testid="edit-pdf-use-signature">Use this signature</Button>
                  </>
                )}
              </div>
            )}
            <details className="text-[13px]">
              <summary className={`w-fit cursor-pointer rounded font-medium max-sm:py-2 ${ring}`}>Watermark and page numbers{watermark.trim() || numbers ? " (on)" : ""}</summary>
              <div className="mt-2 flex flex-wrap items-end gap-4">
                <label className="block">
                  <span className="text-[13px] font-medium">Watermark across every page</span>
                  <input value={watermark} maxLength={60} onChange={(e) => { setWatermark(e.target.value); changed(); }} placeholder="For example DRAFT" data-testid="edit-pdf-watermark"
                    className={`mt-1 h-10 w-64 rounded-xl border border-line bg-surface px-3 text-[14px] max-sm:min-h-11 ${ring}`} />
                </label>
                <label className="flex min-h-11 items-center gap-2">
                  <input type="checkbox" checked={numbers} onChange={(e) => { setNumbers(e.target.checked); changed(); }} className="h-4 w-4 accent-brand" data-testid="edit-pdf-numbers" />
                  Number the pages
                </label>
              </div>
            </details>
            {boxes > 0 && <p className="text-[12.5px] text-muted">Pages with a blacked out area are saved as pictures, so the hidden words are gone for good. Other words on those pages can't be selected afterwards.</p>}
            {error && <p role="alert" className="text-[13px] text-bad" data-testid="edit-pdf-error">{error}</p>}
          </div>
          <p className="text-[13px] text-muted"><span className="font-medium text-fg">{file.name}</span> · {order.length} {order.length === 1 ? "page" : "pages"} · {sizeLabel(file.size)}
            <button type="button" onClick={() => void closeFile()} className={`ml-2 rounded font-medium text-brand underline-offset-2 hover:underline ${ring}`} data-testid="edit-pdf-close">Open another</button>
          </p>
          <ol className="space-y-6" data-testid="edit-pdf-pages">
            {pdf && order.map((idx, k) => (
              <PageCard key={idx} pdf={pdf} idx={idx} pos={k} count={order.length} turn={turn[idx] ?? 0} tool={tool} items={items.filter((i) => i.page === idx)}
                selected={selected} textSize={textSize} signature={signature}
                onAdd={addItem} onPatch={patchItem} onRemove={removeItem} onSelect={setSelected}
                onMove={(by) => movePage(k, by)} onTurn={() => turnPage(idx)} onDelete={() => deletePage(k)} />
            ))}
          </ol>
        </div>
      )}
    </ToolsFrame>
  );
}

function PageCard({ pdf, idx, pos, count, turn, tool, items, selected, textSize, signature, onAdd, onPatch, onRemove, onSelect, onMove, onTurn, onDelete }: {
  pdf: OpenedPdf; idx: number; pos: number; count: number; turn: Turn; tool: Tool; items: EditItem[]; selected: string | null; textSize: number; signature: string | null;
  onAdd: (i: EditItem) => void; onPatch: (id: string, p: Partial<EditItem>) => void; onRemove: (id: string) => void; onSelect: (id: string | null) => void;
  onMove: (by: -1 | 1) => void; onTurn: () => void; onDelete: () => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [drawn, setDrawn] = useState(false);
  const [draft, setDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const drag = useRef<{ id?: string; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const size = pdf.pages[idx];

  // Draw when the page comes near the screen, at the width it is shown.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.round(el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = wrap.current, c = canvas.current;
    if (!el || !c || !width) return;
    let cancelled = false;
    const io = new IntersectionObserver((e) => {
      if (!e[0].isIntersecting) return;
      io.disconnect();
      void pdf.draw(idx, c, width).then(() => { if (!cancelled) setDrawn(true); }).catch(() => {});
    }, { rootMargin: "600px" });
    io.observe(el);
    return () => { cancelled = true; io.disconnect(); };
  }, [pdf, idx, width]);

  const frac = (e: { clientX: number; clientY: number }) => {
    const r = wrap.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const ptH = (pt: number) => pt / size.height;
  const ptW = (pt: number) => pt / size.width;

  function down(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || (e.target as HTMLElement).closest("[data-item]")) return;
    const p = frac(e);
    if (tool === "text") {
      onAdd({ id: nextId(), page: idx, kind: "text", x: p.x, y: p.y, w: ptW(textSize * 12), h: ptH(textSize * 1.3), text: "", size: textSize });
    } else if (tool === "sign") {
      if (!signature) { toast("Make your signature first, then tap the page."); return; }
      const w = ptW(160), h = ptH(160 / 3);
      onAdd({ id: nextId(), page: idx, kind: "sign", x: Math.min(p.x, 1 - w), y: Math.min(p.y, 1 - h), w, h, image: signature });
    } else if (tool === "box") {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      drag.current = { sx: p.x, sy: p.y, ox: 0, oy: 0 };
      setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
    } else onSelect(null);
  }
  function move(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    const p = frac(e);
    if (d.id) { onPatch(d.id, { x: Math.max(0, d.ox + p.x - d.sx), y: Math.max(0, d.oy + p.y - d.sy) }); return; }
    setDraft({ x: Math.min(d.sx, p.x), y: Math.min(d.sy, p.y), w: Math.abs(p.x - d.sx), h: Math.abs(p.y - d.sy) });
  }
  function up() {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id) return;
    if (draft && draft.w > 0.01 && draft.h > 0.005) onAdd({ id: nextId(), page: idx, kind: "box", ...draft });
    setDraft(null);
  }
  function grab(e: ReactPointerEvent<HTMLElement>, it: EditItem) {
    if (tool !== "move" && it.kind !== "text") return;
    onSelect(it.id);
    if ((e.target as HTMLElement).tagName === "TEXTAREA" || (e.target as HTMLElement).closest("button")) return;
    e.stopPropagation();
    wrap.current?.setPointerCapture(e.pointerId);
    const p = frac(e);
    drag.current = { id: it.id, sx: p.x, sy: p.y, ox: it.x, oy: it.y };
  }

  const label = `Page ${pos + 1} of ${count}`;
  return (
    <li className="space-y-2" data-testid="edit-pdf-page" data-page={idx}>
      <div className="flex items-center gap-1.5">
        <span className="mr-auto text-[13px] font-medium text-muted">{label}{turn ? `, turned ${turn}°` : ""}</span>
        <IconBtn label={`Move ${label.toLowerCase()} up`} onClick={() => onMove(-1)} disabled={pos === 0}><IconArrowUp className="h-4 w-4" aria-hidden /></IconBtn>
        <IconBtn label={`Move ${label.toLowerCase()} down`} onClick={() => onMove(1)} disabled={pos === count - 1}><IconArrowDown className="h-4 w-4" aria-hidden /></IconBtn>
        <IconBtn label={`Turn ${label.toLowerCase()}`} onClick={onTurn} testId="edit-pdf-turn"><IconRotate className="h-4 w-4" aria-hidden /></IconBtn>
        <IconBtn label={`Delete ${label.toLowerCase()}`} onClick={onDelete} testId="edit-pdf-delete-page"><IconTrash className="h-4 w-4" aria-hidden /></IconBtn>
      </div>
      <div className="flex justify-center rounded-2xl bg-fill p-2 sm:p-4">
        <div style={{ transform: turn ? `rotate(${turn}deg)` : undefined }} className="w-full max-w-[820px] transition-transform">
          <div ref={wrap} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
            className={`relative w-full touch-none select-none overflow-hidden bg-white shadow-sm ${tool === "move" ? "cursor-default" : "cursor-crosshair"}`}
            style={{ aspectRatio: `${size.width} / ${size.height}` }} aria-label={label} role="group">
            <canvas ref={canvas} className="absolute inset-0 h-full w-full" aria-hidden />
            {!drawn && <span className="absolute inset-0 flex items-center justify-center text-[12px] text-subtle">Loading page</span>}
            {items.map((it) => (
              <div key={it.id} data-item data-testid={`edit-pdf-item-${it.kind}`} onPointerDown={(e) => grab(e, it)}
                className={`group absolute ${it.kind === "box" ? "bg-black" : ""} ${selected === it.id ? "outline outline-2 outline-brand" : "hover:outline hover:outline-1 hover:outline-brand/50"}`}
                style={{ left: `${it.x * 100}%`, top: `${it.y * 100}%`, ...(it.kind === "text" ? { minWidth: `${it.w * 100}%` } : { width: `${it.w * 100}%`, height: `${it.h * 100}%` }) }}>
                {it.kind === "text" && (
                  <textarea autoFocus={selected === it.id && !it.text} value={it.text ?? ""} rows={Math.max(1, (it.text ?? "").split("\n").length)} cols={Math.max(8, ...(it.text ?? "").split("\n").map((l) => l.length + 1))} wrap="off" aria-label="Text on the page" data-testid="edit-pdf-text"
                    onChange={(e) => onPatch(it.id, { text: e.target.value })} placeholder="Type here"
                    className="block min-w-full resize-none overflow-hidden whitespace-pre bg-transparent p-0 font-sans leading-[1.2] text-[#121217] outline-none [field-sizing:content] placeholder:text-neutral-400"
                    style={{ fontSize: `${((it.size ?? 14) / size.width) * (wrap.current?.clientWidth ?? 600)}px` }} />
                )}
                {it.kind === "sign" && it.image && <img src={it.image} alt="Signature" className="h-full w-full object-contain" draggable={false} />}
                {(selected === it.id) && (
                  <button type="button" onClick={(e) => { e.stopPropagation(); onRemove(it.id); }} aria-label="Remove"
                    className={`absolute -right-3 -top-3 flex h-6 w-6 items-center justify-center rounded-full bg-surface text-fg shadow ring-1 ring-line max-sm:h-9 max-sm:w-9 ${ring}`} data-testid="edit-pdf-remove-item"><IconClose className="h-3.5 w-3.5" aria-hidden /></button>
                )}
              </div>
            ))}
            {draft && <div className="pointer-events-none absolute bg-black/80" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%` }} />}
          </div>
        </div>
      </div>
    </li>
  );
}

function IconBtn({ label, onClick, disabled, children, testId }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode; testId?: string }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled} data-testid={testId}
      className={`flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg disabled:opacity-40 max-sm:h-11 max-sm:w-11 ${ring}`}>{children}</button>
  );
}
