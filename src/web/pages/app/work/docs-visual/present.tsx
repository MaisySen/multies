/**
 * R89: Present. The doc as slides (split at H1 and H2, see lib/slides.ts), drawn by our own renderer.
 * Keys: arrows, space (shift space back), Page up and down, Home, End; Escape leaves. A phone swipes.
 * Presenter view shows the slide, the next one, the speaker notes and a timer, on this screen or in a second
 * window kept in step over a broadcast channel.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IconArrowLeft, IconArrowRight, IconClose, IconMaximize, IconMinimize, IconMonitor, IconNotes, IconPause, IconPlay, IconRefresh } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";
import { WorkspaceMark } from "@/web/lib/brand";
import { useMe } from "@/web/lib/queries";
import { clock, slideKey, splitSlides, type Slide } from "@/web/lib/slides";
import type { PMNode } from "@/web/lib/mindmap-tree";
import { Blocks } from "./pm-render";

const STAGE_W = 1600, STAGE_H = 900;
const channelName = (docId: string) => `mm-present:${docId}`;
type Msg = { type: "go"; index: number } | { type: "hello" } | { type: "bye" };

function useViewport() {
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return vp;
}

/** The slide itself. `fit` scales a 16:9 stage into the box; `flow` (a phone held upright) lets the slide fill and scroll. */
export function SlideView({ slide, index, count, layout, workspace }: { slide: Slide; index: number; count: number; layout: "fit" | "flow" | "thumb"; workspace: string }) {
  const body = slide.kind === "title" ? (
    <div className="flex h-full flex-col justify-center gap-[0.6em]">
      <div className="flex items-center gap-[0.5em] text-[0.55em] font-medium text-muted"><WorkspaceMark name={workspace} className="h-[1.6em] w-[1.6em]" />{workspace}</div>
      <h1 className="text-[2.2em] font-bold leading-[1.05] tracking-[-0.02em] text-fg">{slide.title || "Untitled"}</h1>
      {slide.subtitle && <p className="max-w-[80%] text-[0.9em] text-muted">{slide.subtitle}</p>}
      <span aria-hidden className="mt-[0.4em] block h-[0.18em] w-[3em] rounded-full bg-brand" />
    </div>
  ) : (
    <div className="flex h-full flex-col gap-[0.5em]">
      {slide.title && <h2 className="text-[1.5em] font-bold leading-[1.1] tracking-[-0.015em] text-fg">{slide.title}</h2>}
      <div className="mm-slide-body min-h-0 flex-1 space-y-[0.5em] overflow-hidden text-fg [&_h3]:text-[1.05em] [&_h3]:font-semibold [&_h4]:font-semibold [&_li]:my-[0.15em]">
        <Blocks blocks={slide.blocks as PMNode[]} keyPrefix={`s${index}`} />
      </div>
    </div>
  );
  const number = <span className="absolute bottom-[0.9em] right-[1.2em] text-[0.45em] tabular-nums text-subtle" data-testid="slide-number">{index + 1} / {count}</span>;
  if (layout === "flow") {
    return <div className="relative min-h-full bg-surface px-6 pb-16 pt-10 text-[20px] leading-[1.45]" data-testid="slide" data-slide={index}>{body}{number}</div>;
  }
  return (
    <div className="relative overflow-hidden bg-surface text-[36px] leading-[1.4]" style={{ width: STAGE_W, height: STAGE_H, padding: "88px 112px" }} data-testid={layout === "thumb" ? "slide-thumb" : "slide"} data-slide={index}>
      {body}{number}
    </div>
  );
}

function Scaled({ children, w, h }: { children: ReactNode; w: number; h: number }) {
  const s = Math.min(w / STAGE_W, h / STAGE_H);
  return (
    <div style={{ width: STAGE_W * s, height: STAGE_H * s }} className="relative overflow-hidden rounded-[6px] shadow-pop">
      <div style={{ transform: `scale(${s})`, transformOrigin: "0 0", width: STAGE_W, height: STAGE_H }}>{children}</div>
    </div>
  );
}

function useTimer() {
  const [start, setStart] = useState<number | null>(() => Date.now());
  const [acc, setAcc] = useState(0);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 500); return () => clearInterval(t); }, []);
  const elapsed = acc + (start ? Date.now() - start : 0);
  return {
    elapsed, running: start !== null,
    toggle: () => { if (start) { setAcc(acc + Date.now() - start); setStart(null); } else setStart(Date.now()); },
    reset: () => { setAcc(0); setStart(Date.now()); },
  };
}

function PresenterPanel({ slides, index, go, workspace, compact }: { slides: Slide[]; index: number; go: (i: number) => void; workspace: string; compact?: boolean }) {
  const timer = useTimer();
  const vp = useViewport();
  const cur = slides[index];
  const next = slides[index + 1];
  const mainW = compact ? vp.w - 32 : Math.min(vp.w * 0.58, 1100);
  return (
    <div className={cn("grid h-full gap-4 p-4", compact ? "grid-rows-[auto_1fr]" : "grid-cols-[auto_1fr]")} data-testid="presenter-view">
      <div className="flex flex-col gap-3">
        <Scaled w={mainW} h={compact ? vp.h * 0.32 : vp.h * 0.62}><SlideView slide={cur} index={index} count={slides.length} layout="thumb" workspace={workspace} /></Scaled>
        <div className="flex items-center gap-2 text-white">
          <button type="button" className="mm-present-btn" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous slide"><IconArrowLeft className="h-5 w-5" /></button>
          <span className="min-w-16 text-center text-[15px] tabular-nums" aria-live="polite">{index + 1} / {slides.length}</span>
          <button type="button" className="mm-present-btn" onClick={() => go(index + 1)} disabled={index >= slides.length - 1} aria-label="Next slide"><IconArrowRight className="h-5 w-5" /></button>
          <span className="ml-auto font-mono text-[22px] tabular-nums" data-testid="presenter-timer" aria-label={`Time ${clock(timer.elapsed)}`}>{clock(timer.elapsed)}</span>
          <button type="button" className="mm-present-btn" onClick={timer.toggle} aria-label={timer.running ? "Pause the timer" : "Start the timer"}>{timer.running ? <IconPause className="h-4 w-4" /> : <IconPlay className="h-4 w-4" />}</button>
          <button type="button" className="mm-present-btn" onClick={timer.reset} aria-label="Restart the timer"><IconRefresh className="h-4 w-4" /></button>
        </div>
      </div>
      <div className="flex min-h-0 flex-col gap-3">
        {!compact && (
          <div>
            <p className="mb-1.5 text-[12px] font-medium uppercase tracking-wide text-white/60">Next</p>
            {next ? <Scaled w={Math.min(vp.w * 0.3, 520)} h={vp.h * 0.26}><SlideView slide={next} index={index + 1} count={slides.length} layout="thumb" workspace={workspace} /></Scaled> : <p className="text-[14px] text-white/60">This is the last slide.</p>}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto rounded-xl bg-white/5 p-4">
          <p className="mb-1.5 text-[12px] font-medium uppercase tracking-wide text-white/60">Speaker notes</p>
          <p className="whitespace-pre-wrap text-[18px] leading-relaxed text-white" data-testid="speaker-notes">{cur.notes || "No notes for this slide. Add a callout that starts with Notes to write some."}</p>
        </div>
      </div>
    </div>
  );
}

export interface PresentProps { docId: string; doc: PMNode; title: string; start?: number; onClose: () => void }

export function PresentOverlay({ docId, doc, title, start = 0, onClose }: PresentProps) {
  const me = useMe();
  const workspace = me.data?.organization?.name ?? "";
  const slides = useMemo(() => splitSlides(doc, title), [doc, title]);
  const [index, setIndex] = useState(Math.min(start, slides.length - 1));
  const [presenter, setPresenter] = useState(false);
  const [full, setFull] = useState(false);
  const [chrome, setChrome] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  const bc = useRef<BroadcastChannel | null>(null);
  const vp = useViewport();
  const flow = vp.w < 700 && vp.h > vp.w;

  const go = useCallback((i: number, from?: "remote") => {
    const n = Math.max(0, Math.min(slides.length - 1, i));
    setIndex(n);
    if (from !== "remote") bc.current?.postMessage({ type: "go", index: n } satisfies Msg);
  }, [slides.length]);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(channelName(docId));
    bc.current = ch;
    ch.onmessage = (e: MessageEvent<Msg>) => {
      if (e.data?.type === "go") go(e.data.index, "remote");
      if (e.data?.type === "hello") ch.postMessage({ type: "go", index: indexRef.current } satisfies Msg);
    };
    return () => { ch.postMessage({ type: "bye" } satisfies Msg); ch.close(); bc.current = null; };
  }, [docId, go]);
  const indexRef = useRef(index);
  indexRef.current = index;

  // Full screen when the browser allows it; the overlay already covers the window either way.
  useEffect(() => {
    const el = root.current;
    if (el?.requestFullscreen && !document.fullscreenElement) el.requestFullscreen().then(() => setFull(true)).catch(() => setFull(false));
    const onFs = () => setFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    root.current?.focus();
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, [contenteditable=true]")) return;
      if (e.key === "Escape") { e.preventDefault(); if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); onClose(); return; }
      if (e.key === "f" || e.key === "F") { e.preventDefault(); toggleFull(); return; }
      if (e.target instanceof HTMLButtonElement && (e.key === " " || e.key === "Enter")) return;
      const n = slideKey(e.key, indexRef.current, slides.length, e.shiftKey);
      if (n !== null) { e.preventDefault(); go(n); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [go, slides.length, onClose]);

  // Chrome hides after a few still seconds on a big screen.
  useEffect(() => {
    if (flow) return;
    let t = setTimeout(() => setChrome(false), 2500);
    const on = () => { setChrome(true); clearTimeout(t); t = setTimeout(() => setChrome(false), 2500); };
    window.addEventListener("pointermove", on);
    return () => { clearTimeout(t); window.removeEventListener("pointermove", on); };
  }, [flow]);

  const toggleFull = () => {
    const el = root.current;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void el?.requestFullscreen?.().catch(() => {});
  };

  // Swipe on touch screens.
  const touch = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => { if (e.pointerType !== "mouse") touch.current = { x: e.clientX, y: e.clientY }; };
  const onPointerUp = (e: React.PointerEvent) => {
    const t = touch.current;
    touch.current = null;
    if (!t) return;
    const dx = e.clientX - t.x, dy = e.clientY - t.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3) go(indexRef.current + (dx < 0 ? 1 : -1));
  };

  const openPresenterWindow = () => {
    const w = window.open(`/app/docs/${encodeURIComponent(docId)}?present=presenter&slide=${index}`, `mm-presenter-${docId}`, "popup,width=1200,height=760");
    if (!w) setPresenter(true);
  };

  const slide = slides[index];
  return (
    <div ref={root} role="dialog" aria-modal="true" aria-label={`Presenting ${title || "Untitled"}`} tabIndex={-1}
      className="mm-present fixed inset-0 z-[80] flex flex-col bg-[#111] outline-none" data-testid="present" data-index={index}
      onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
      <div className="sr-only" aria-live="polite">Slide {index + 1} of {slides.length}: {slide.title}</div>
      {presenter ? (
        <PresenterPanel slides={slides} index={index} go={go} workspace={workspace} compact={vp.w < 900} />
      ) : flow ? (
        <div className="min-h-0 flex-1 overflow-auto"><SlideView slide={slide} index={index} count={slides.length} layout="flow" workspace={workspace} /></div>
      ) : (
        <div className="grid min-h-0 flex-1 place-items-center" onClick={(e) => { if (e.target === e.currentTarget) go(index + 1); }}>
          <Scaled w={vp.w} h={vp.h}><SlideView slide={slide} index={index} count={slides.length} layout="fit" workspace={workspace} /></Scaled>
        </div>
      )}
      <div className={cn("absolute inset-x-0 bottom-0 flex items-center gap-1 p-3 transition-opacity duration-200 [padding-bottom:max(12px,env(safe-area-inset-bottom))]", chrome || flow || presenter ? "opacity-100" : "pointer-events-none opacity-0", flow && "bg-surface/95 border-t border-line")}>
        <div className={cn("mx-auto flex items-center gap-1 rounded-full px-2 py-1", flow ? "" : "bg-black/70 backdrop-blur")}>
          <button type="button" className={cn("mm-present-btn", flow && "mm-present-btn-light")} onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous slide"><IconArrowLeft className="h-5 w-5" /></button>
          <span className={cn("min-w-14 text-center text-[13px] tabular-nums", flow ? "text-fg" : "text-white")}>{index + 1} / {slides.length}</span>
          <button type="button" className={cn("mm-present-btn", flow && "mm-present-btn-light")} onClick={() => go(index + 1)} disabled={index >= slides.length - 1} aria-label="Next slide"><IconArrowRight className="h-5 w-5" /></button>
          <span className="mx-1 h-5 w-px bg-white/20" aria-hidden />
          <button type="button" className={cn("mm-present-btn", flow && "mm-present-btn-light")} aria-pressed={presenter} onClick={() => setPresenter((p) => !p)} aria-label={presenter ? "Hide presenter view" : "Presenter view"} title="Presenter view" data-testid="presenter-toggle"><IconNotes className="h-5 w-5" /></button>
          {!flow && <button type="button" className="mm-present-btn" onClick={openPresenterWindow} aria-label="Open presenter view in a new window" title="Presenter view in a new window"><IconMonitor className="h-5 w-5" /></button>}
          {!flow && <button type="button" className="mm-present-btn" onClick={toggleFull} aria-label={full ? "Leave full screen" : "Full screen"}>{full ? <IconMinimize className="h-5 w-5" /> : <IconMaximize className="h-5 w-5" />}</button>}
          <button type="button" className={cn("mm-present-btn", flow && "mm-present-btn-light")} onClick={onClose} aria-label="Stop presenting" data-testid="present-close"><IconClose className="h-5 w-5" /></button>
        </div>
      </div>
    </div>
  );
}

/** The second window: presenter view only, following (and steering) the main window. */
export function PresenterWindow({ docId, doc, title, start = 0 }: { docId: string; doc: PMNode; title: string; start?: number }) {
  const me = useMe();
  const slides = useMemo(() => splitSlides(doc, title), [doc, title]);
  const [index, setIndex] = useState(Math.min(start, slides.length - 1));
  const bc = useRef<BroadcastChannel | null>(null);
  const indexRef = useRef(index);
  indexRef.current = index;
  const go = useCallback((i: number, remote = false) => {
    const n = Math.max(0, Math.min(slides.length - 1, i));
    setIndex(n);
    if (!remote) bc.current?.postMessage({ type: "go", index: n } satisfies Msg);
  }, [slides.length]);
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(channelName(docId));
    bc.current = ch;
    ch.onmessage = (e: MessageEvent<Msg>) => { if (e.data?.type === "go") go(e.data.index, true); };
    ch.postMessage({ type: "hello" } satisfies Msg);
    return () => ch.close();
  }, [docId, go]);
  useEffect(() => {
    document.title = `Presenter view: ${title || "Untitled"}`;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLButtonElement && (e.key === " " || e.key === "Enter")) return;
      const n = slideKey(e.key, indexRef.current, slides.length, e.shiftKey);
      if (n !== null) { e.preventDefault(); go(n); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, slides.length, title]);
  return (
    <div className="mm-present fixed inset-0 z-[80] bg-[#111]" role="main" aria-label="Presenter view">
      <PresenterPanel slides={slides} index={index} go={go} workspace={me.data?.organization?.name ?? ""} />
    </div>
  );
}
