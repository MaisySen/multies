/**
 * R130: guided onboarding (flag TOURS_R130). The Get started checklist (Home panel and a progress ring in the app
 * shell), the tour runner (our own spotlight and popover, no third party script) and the element picker the tour
 * builder uses. Mounted only inside the signed in app shell, so public pages (sites, blog, booking, forms, reports)
 * and project guests never see any of it. No tracking: the only writes are the person's own progress rows.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useLocation, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { useConfig, useMe } from "@/web/lib/queries";
import { openPalette } from "@/web/lib/shortcuts";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Card } from "@/web/components/ui/misc";
import { Dialog } from "@/web/components/ui/dialog";
import { IconCheck, IconClose } from "@/web/components/ui/icons";
import {
  BUILTIN_TOURS, checklistVisible, inApp, pageMatches, TARGET_RE,
  type AdminTour, type ChecklistStepDef, type ChecklistView, type TourDef, type ToursMe,
} from "@/shared/tours-r130";

export const toursKey = ["tours-r130", "me"] as const;
const PICK_KEY = "multies-tour-pick";
const PREVIEW_KEY = "multies-tour-preview";

/* ------------------------------------------------------------------ a tiny store the shell and pages share */

type Running = { tour: TourDef; preview: boolean } | null;
type Store = { running: Running; pending: TourDef | null; panel: boolean; list: boolean };
let store: Store = { running: null, pending: null, panel: false, list: false };
const subs = new Set<() => void>();
const set = (p: Partial<Store>) => { store = { ...store, ...p }; subs.forEach((f) => f()); };
const useStore = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => store, () => store);

/** Start a tour now (on this page) or after navigating to its page. */
export function startTour(tour: TourDef, opts: { preview?: boolean } = {}) {
  if (store.running) return;
  set({ running: { tour, preview: !!opts.preview }, pending: null, panel: false, list: false });
}
export const openGetStarted = () => set({ panel: true, list: false });
export const openToursList = () => set({ list: true, panel: false });

export function useToursMe() {
  const config = useConfig();
  const on = !!config.data?.toursR130;
  const q = useQuery({ queryKey: toursKey, enabled: on, staleTime: 60_000, queryFn: () => api.get<ToursMe>("/tours/me") });
  return { on: on && !!q.data?.enabled, data: q.data, query: q };
}

function useChecklistAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { action: "mark" | "dismiss" | "resume" | "celebrated"; step?: string }) => api.post<ToursMe>("/tours/checklist", b),
    onSuccess: (d) => qc.setQueryData(toursKey, d),
  });
}

/* ------------------------------------------------------------------ target finding */

const reduceMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const s = getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
}
/** The first visible element carrying this id as data-tour or data-testid. Ids are checked, never used as CSS paths. */
export function findTarget(id: string): HTMLElement | null {
  if (!TARGET_RE.test(id)) return null;
  const esc = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id;
  const all = document.querySelectorAll<HTMLElement>(`[data-tour="${esc}"], [data-testid="${esc}"]`);
  for (const el of all) if (visible(el) && !el.closest("[data-tour-ui]")) return el;
  return null;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitForAny(ids: string[], ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (ids.some((id) => findTarget(id))) return; await wait(100); }
}

/* ------------------------------------------------------------------ the runner */

function TourRunner({ run, onEnd }: { run: NonNullable<Running>; onEnd: (state: "done" | "skipped" | "empty", step: number) => void }) {
  const [steps, setSteps] = useState<TourDef["steps"] | null>(null);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [vw, setVw] = useState(() => window.innerWidth);
  const pop = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null);
  const titleId = useId(); const bodyId = useId();

  // Steps whose element is not on this screen (another page, hidden at this size) are skipped, never broken.
  useEffect(() => {
    let live = true;
    void (async () => {
      const ids = run.tour.steps.map((s) => s.target);
      await waitForAny(ids, 1500);
      if (!live) return;
      const here = run.tour.steps.filter((s) => findTarget(s.target));
      if (!here.length) onEnd("empty", 0); else setSteps(here);
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  const step = steps?.[i];
  const close = useCallback((state: "done" | "skipped") => {
    onEnd(state, i);
    const back = opener.current;
    requestAnimationFrame(() => { if (back && document.contains(back)) back.focus(); else document.getElementById("main")?.focus(); });
  }, [i, onEnd]);
  const go = useCallback((d: 1 | -1) => {
    if (!steps) return;
    let n = i + d;
    while (n >= 0 && n < steps.length && !findTarget(steps[n]!.target)) n += d; // the element went away: skip it
    if (n >= steps.length) close("done"); else if (n >= 0) setI(n);
  }, [i, steps, close]);

  // Measure the element, keep it in view, follow scroll and resize.
  useLayoutEffect(() => {
    if (!step) return;
    const el = findTarget(step.target);
    if (!el) { go(1); return; }
    el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduceMotion() ? "auto" : "smooth" });
    let raf = 0;
    const measure = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { const t = findTarget(step.target); setRect(t ? t.getBoundingClientRect() : null); setVw(window.innerWidth); }); };
    measure();
    const t = setTimeout(measure, 350);
    window.addEventListener("resize", measure); window.addEventListener("scroll", measure, true);
    return () => { clearTimeout(t); cancelAnimationFrame(raf); window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); };
  }, [step, go]);

  useEffect(() => { if (step) pop.current?.querySelector<HTMLElement>("[data-tour-primary]")?.focus(); }, [step]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close("skipped"); }
    else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
    else if (e.key === "Tab") { // focus stays in the popover while the tour is open
      const f = [...(pop.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])];
      if (!f.length) return;
      const at = f.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && at <= 0) { e.preventDefault(); f[f.length - 1]!.focus(); }
      else if (!e.shiftKey && at === f.length - 1) { e.preventDefault(); f[0]!.focus(); }
    }
  };

  if (!steps || !step) return null;
  const pad = 6;
  const W = Math.min(340, vw - 24);
  const r = rect;
  const below = !r || r.bottom + 180 < window.innerHeight || r.top < 200;
  const left = r ? Math.max(12, Math.min(vw - W - 12, r.left + r.width / 2 - W / 2)) : (vw - W) / 2;
  const top = r ? (below ? Math.min(window.innerHeight - 200, r.bottom + pad + 10) : undefined) : window.innerHeight / 3;
  const bottom = r && !below ? Math.max(12, window.innerHeight - r.top + pad + 10) : undefined;
  const last = i === steps.length - 1;
  return (
    <div data-tour-ui className="fixed inset-0 z-[90]" onKeyDown={onKey}>
      {/* Clicks outside the popover do nothing: a tour never changes the page under it. */}
      <div className="absolute inset-0" aria-hidden onMouseDown={(e) => e.preventDefault()} />
      {r && <div aria-hidden data-testid="tour-spotlight" className="pointer-events-none absolute rounded-lg ring-2 ring-brand motion-safe:transition-all motion-safe:duration-200"
        style={{ left: r.left - pad, top: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2, boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.45)" }} />}
      {!r && <div aria-hidden className="absolute inset-0 bg-black/45" />}
      <div ref={pop} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} data-testid="tour-popover"
        className="absolute rounded-xl border border-line bg-surface p-4 text-fg shadow-card motion-safe:animate-fade-in"
        style={{ left, top, bottom, width: W }}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[11.5px] font-medium text-subtle" data-testid="tour-count">{`Step ${i + 1} of ${steps.length}`}{run.preview ? " · Preview" : ""}</p>
            <h2 id={titleId} className="mt-0.5 text-[15px] font-semibold">{step.title}</h2>
          </div>
          <button type="button" onClick={() => close("skipped")} aria-label="Close tour" data-testid="tour-close"
            className="-mr-1 -mt-1 grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60">
            <IconClose className="h-4 w-4" aria-hidden />
          </button>
        </div>
        {step.body && <p id={bodyId} className="mt-1.5 whitespace-pre-line text-[13.5px] leading-relaxed text-muted">{step.body}</p>}
        {!step.body && <span id={bodyId} className="sr-only">{step.title}</span>}
        <div className="mt-4 flex items-center justify-between gap-2">
          <div className="flex gap-1" aria-hidden>{steps.map((_, n) => <span key={n} className={cn("h-1.5 w-1.5 rounded-full", n === i ? "bg-brand" : "bg-line")} />)}</div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => go(-1)} disabled={i === 0} data-testid="tour-back">Back</Button>
            <Button size="sm" onClick={() => go(1)} data-tour-primary data-testid="tour-next">{last ? "Done" : "Next"}</Button>
          </div>
        </div>
        <p className="sr-only" aria-live="polite">{`Step ${i + 1} of ${steps.length}: ${step.title}`}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ checklist */

function Ring({ done, total, size = 22 }: { done: number; total: number; size?: number }) {
  const r = (size - 4) / 2; const c = 2 * Math.PI * r; const f = total ? done / total : 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="shrink-0 -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={2.5} className="stroke-line" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={2.5} strokeLinecap="round" className="stroke-brand motion-safe:transition-[stroke-dashoffset] motion-safe:duration-300"
        strokeDasharray={c} strokeDashoffset={c * (1 - f)} />
    </svg>
  );
}

export function ChecklistPanel({ view, embedded, onNavigate }: { view: ChecklistView; embedded?: boolean; onNavigate?: () => void }) {
  const act = useChecklistAction();
  const navigate = useNavigate();
  const doStep = (s: ChecklistStepDef) => {
    onNavigate?.();
    if (s.action === "palette") { act.mutate({ action: "mark", step: "palette" }); openPalette(); return; }
    if (s.action === "tour") { const t = BUILTIN_TOURS[0]!; set({ pending: t, panel: false }); navigate(t.page); return; }
    if (s.to) navigate(s.to);
  };
  const hide = () => {
    act.mutate({ action: "dismiss" }, {
      onSuccess: () => toast("Checklist hidden. Bring it back from your account menu, Get started.", { action: { label: "Undo", onClick: () => act.mutate({ action: "resume" }) } }),
      onError: showError,
    });
    onNavigate?.();
  };
  if (view.complete) {
    return (
      <Card className={cn("flex items-center gap-4 px-5 py-4", embedded && "border-0 shadow-none")} data-testid="checklist-complete">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ok-soft text-ok"><IconCheck className="h-5 w-5" aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">You're all set</h2>
          <p className="text-[13px] text-muted">Every step is done. Tours stay in your account menu.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => { act.mutate({ action: "celebrated" }); onNavigate?.(); }} data-testid="checklist-done">Done</Button>
      </Card>
    );
  }
  const next = view.steps.findIndex((s) => !s.done);
  return (
    <Card className={cn("overflow-hidden", embedded && "border-0 shadow-none")} data-testid="checklist" aria-labelledby="checklist-title">
      <div className="flex items-center gap-3 px-5 pb-3 pt-4">
        <Ring done={view.doneCount} total={view.total} size={28} />
        <div className="min-w-0 flex-1">
          <h2 id="checklist-title" className="text-sm font-semibold">Get started</h2>
          <p className="text-xs text-muted" data-testid="checklist-count">{view.doneCount} of {view.total} done</p>
        </div>
        <button type="button" onClick={hide} aria-label="Hide the checklist" data-testid="checklist-hide"
          className="grid h-10 w-10 place-items-center rounded-full text-subtle hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 sm:h-8 sm:w-8">
          <IconClose className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <ol className="border-t border-line">
        {view.steps.map((s, n) => (
          <li key={s.id} className="flex items-center gap-3 border-b border-line px-5 py-3 last:border-b-0" data-testid={`checklist-step-${s.id}`} data-done={s.done ? "1" : "0"}>
            <span className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-full border", s.done ? "border-ok/40 bg-ok-soft text-ok" : "border-line text-transparent")} aria-hidden>
              <IconCheck className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className={cn("text-[13.5px] font-medium", s.done && "text-muted line-through decoration-line")}>{s.title}<span className="sr-only">{s.done ? ", done" : ", not done yet"}</span></p>
              {!s.done && <p className="text-[12.5px] text-muted">{s.body}</p>}
            </div>
            {!s.done && <Button size="sm" variant={n === next ? "primary" : "secondary"} onClick={() => doStep(s)} data-testid={`checklist-go-${s.id}`}>
              {s.action === "palette" ? "Try it" : s.action === "tour" ? "Start" : "Open"}<span className="sr-only">{`: ${s.title}`}</span>
            </Button>}
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** Home: the panel while the checklist is open. Nothing at all when it is hidden, done or the flag is off. */
export function GetStartedCard() {
  const t = useToursMe();
  if (!t.on || !t.data?.checklist || !checklistVisible(t.data.checklist)) return null;
  return <div className="mb-6" data-tour="get-started"><ChecklistPanel view={t.data.checklist} /></div>;
}

/** App shell: a small ring that opens the checklist. */
export function ChecklistRing({ className }: { className?: string }) {
  const t = useToursMe();
  const v = t.data?.checklist;
  if (!t.on || !v || !checklistVisible(v) || v.complete) return null;
  return (
    <button type="button" onClick={openGetStarted} data-testid="tours-ring" data-tour="tours-ring"
      aria-label={`Get started, ${v.doneCount} of ${v.total} done`}
      className={cn("grid h-11 w-11 shrink-0 place-items-center rounded-full hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 lg:h-8 lg:w-8", className)}>
      <Ring done={v.doneCount} total={v.total} />
    </button>
  );
}

/* ------------------------------------------------------------------ picker (builder) */

type Pick = { tourId: string; index: number };
function readPick(): Pick | null { try { const p = JSON.parse(sessionStorage.getItem(PICK_KEY) ?? "null") as Pick | null; return p && typeof p.tourId === "string" ? p : null; } catch { return null; } }
export function beginPick(p: Pick) { sessionStorage.setItem(PICK_KEY, JSON.stringify(p)); }
export function beginPreview(id: string) { sessionStorage.setItem(PREVIEW_KEY, id); }
function idOf(el: Element | null): string | null {
  for (let e = el; e && e !== document.body; e = e.parentElement) {
    if (e.closest("[data-tour-ui]")) return null;
    const id = e.getAttribute("data-tour") ?? e.getAttribute("data-testid");
    if (id && TARGET_RE.test(id) && visible(e)) return id;
  }
  return null;
}
function labelOf(el: HTMLElement, id: string) {
  const t = (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
  return t ? `${t.slice(0, 48)}` : id;
}

function PickerBar({ pick, onDone }: { pick: Pick; onDone: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [hover, setHover] = useState<DOMRect | null>(null);
  const [items, setItems] = useState<{ id: string; label: string }[]>([]);
  const save = useMutation({
    mutationFn: async (target: string) => {
      const t = await api.get<AdminTour>(`/tours/admin/${encodeURIComponent(pick.tourId)}`);
      const steps = [...t.steps];
      while (steps.length <= pick.index) steps.push({ target, title: "New step", body: "" });
      steps[pick.index] = { ...steps[pick.index]!, target };
      return api.patch<AdminTour>(`/tours/admin/${encodeURIComponent(pick.tourId)}`, { steps });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["tours-r130", "admin"] }); finish(); toast("Element picked"); },
    onError: showError,
  });
  const finish = () => { sessionStorage.removeItem(PICK_KEY); onDone(); navigate(`/app/settings/tours?edit=${encodeURIComponent(pick.tourId)}`); };
  useEffect(() => {
    const scan = () => {
      const seen = new Set<string>(); const out: { id: string; label: string }[] = [];
      document.querySelectorAll<HTMLElement>("[data-tour], [data-testid]").forEach((el) => {
        if (out.length >= 60 || el.closest("[data-tour-ui]")) return;
        const id = el.getAttribute("data-tour") ?? el.getAttribute("data-testid") ?? "";
        if (!TARGET_RE.test(id) || seen.has(id) || !visible(el)) return;
        seen.add(id); out.push({ id, label: labelOf(el, id) });
      });
      setItems(out);
    };
    const t = setTimeout(scan, 600);
    const over = (e: MouseEvent) => { const id = idOf(e.target as Element); const el = id ? findTarget(id) : null; setHover(el ? el.getBoundingClientRect() : null); };
    const click = (e: MouseEvent) => {
      if ((e.target as Element).closest("[data-tour-ui]")) return;
      const id = idOf(e.target as Element); if (!id) return;
      e.preventDefault(); e.stopPropagation(); save.mutate(id);
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") finish(); };
    document.addEventListener("mouseover", over, true); document.addEventListener("click", click, true); document.addEventListener("keydown", key);
    return () => { clearTimeout(t); document.removeEventListener("mouseover", over, true); document.removeEventListener("click", click, true); document.removeEventListener("keydown", key); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      {hover && <div aria-hidden data-tour-ui className="pointer-events-none fixed z-[89] rounded-md ring-2 ring-brand" style={{ left: hover.left - 3, top: hover.top - 3, width: hover.width + 6, height: hover.height + 6 }} />}
      <div data-tour-ui role="region" aria-label="Pick an element" data-testid="tour-picker"
        className="fixed inset-x-3 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-[91] mx-auto max-w-xl rounded-xl border border-line bg-surface p-3 shadow-card lg:bottom-4">
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-[13.5px] font-medium">{`Choose an element for step ${pick.index + 1}`}</p>
          <Button size="sm" variant="secondary" onClick={finish} data-testid="tour-picker-cancel">Cancel</Button>
        </div>
        <p className="mt-0.5 text-[12.5px] text-muted">Click it on the page, or pick it from this list.</p>
        <ul className="mt-2 max-h-40 space-y-px overflow-y-auto" aria-label="Elements on this page">
          {items.map((it) => (
            <li key={it.id}>
              <button type="button" onClick={() => save.mutate(it.id)} onFocus={() => { const el = findTarget(it.id); setHover(el ? el.getBoundingClientRect() : null); }}
                className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60" data-testid={`tour-pick-${it.id}`}>
                <span className="min-w-0 flex-1 truncate">{it.label}</span><span className="shrink-0 font-mono text-[11px] text-subtle">{it.id}</span>
              </button>
            </li>
          ))}
          {!items.length && <li className="px-2 py-1 text-[12.5px] text-muted">Looking for elements on this page…</li>}
        </ul>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ host (mounted once in the app shell) */

export function ToursHost() {
  const t = useToursMe();
  const s = useStore();
  const loc = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useMe();
  const act = useChecklistAction();
  const [pick, setPick] = useState<Pick | null>(null);
  const started = useRef(new Set<string>());
  const view = t.data?.checklist;
  const markable = useMemo(() => new Set((view?.steps ?? []).filter((x) => x.kind === "mark" && !x.done).map((x) => x.id)), [view]);
  const phone = typeof window !== "undefined" && window.innerWidth < 1024;

  const progress = useMutation({
    mutationFn: (p: { key: string; state: "done" | "skipped"; step: number }) => api.post("/tours/progress", p),
    onSuccess: () => qc.invalidateQueries({ queryKey: toursKey }),
  });

  // Client observed steps: Ctrl K (or the search entry) and opening Mail.
  useEffect(() => {
    if (!t.on || !markable.has("palette")) return;
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") act.mutate({ action: "mark", step: "palette" }); };
    const click = (e: MouseEvent) => { if ((e.target as Element)?.closest?.('[data-testid="topbar-search-entry"], [data-testid="topbar-search"]')) act.mutate({ action: "mark", step: "palette" }); };
    window.addEventListener("keydown", key, true); document.addEventListener("click", click, true);
    return () => { window.removeEventListener("keydown", key, true); document.removeEventListener("click", click, true); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.on, markable]);
  useEffect(() => {
    if (t.on && markable.has("open_mail") && (loc.pathname === "/app/mail" || loc.pathname.startsWith("/app/mail/"))) act.mutate({ action: "mark", step: "open_mail" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.on, markable, loc.pathname]);

  // Picker and preview requests from the builder, a tour waiting for its page, and workspace tours (once each).
  useEffect(() => {
    if (!t.on || !inApp(loc.pathname)) return;
    const p = readPick();
    if (p && t.data?.canBuild) { setPick(p); return; }
    const pv = sessionStorage.getItem(PREVIEW_KEY);
    if (pv && t.data?.canBuild) {
      sessionStorage.removeItem(PREVIEW_KEY);
      void api.get<AdminTour>(`/tours/admin/${encodeURIComponent(pv)}`).then((tour) => startTour(tour, { preview: true }), showError);
      return;
    }
    if (store.running) return;
    if (store.pending && pageMatches(store.pending.page, loc.pathname)) { const tour = store.pending; const id = setTimeout(() => startTour(tour), 500); return () => clearTimeout(id); }
    const next = (t.data?.tours ?? []).find((x) => pageMatches(x.page, loc.pathname) && !started.current.has(x.id));
    if (next) { const id = setTimeout(() => { started.current.add(next.id); startTour(next); }, 900); return () => clearTimeout(id); }
  }, [t.on, t.data, loc.pathname, s.pending]);

  const end = useCallback((state: "done" | "skipped" | "empty", step: number) => {
    const run = store.running;
    set({ running: null });
    if (!run || run.preview || state === "empty") { if (run?.preview && state !== "empty") toast("Preview finished"); return; }
    progress.mutate({ key: run.tour.id, state, step });
  }, [progress]);

  if (!t.on || !inApp(loc.pathname)) return null;
  const tours = BUILTIN_TOURS.filter((x) => !x.phoneOnly || phone);
  return (
    <>
      {s.running && <TourRunner key={s.running.tour.id + String(s.running.preview)} run={s.running} onEnd={end} />}
      {pick && <PickerBar pick={pick} onDone={() => setPick(null)} />}
      <Dialog open={s.panel && !!view} onClose={() => set({ panel: false })} title="Get started" className="max-w-lg">
        {view && <ChecklistPanel view={view} embedded onNavigate={() => set({ panel: false })} />}
      </Dialog>
      <Dialog open={s.list} onClose={() => set({ list: false })} title="Tours" description="Short walk throughs of where things live.">
        <ul className="divide-y divide-line" data-testid="tours-list">
          {tours.map((x) => (
            <li key={x.id} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-medium">{x.name}</p>
                <p className="text-[12.5px] text-muted">{t.data?.seen.includes(x.id) ? "Seen" : `${x.steps.length} short steps`}</p>
              </div>
              <Button size="sm" variant="secondary" data-testid={`tours-start-${x.id.replace("builtin:", "")}`}
                onClick={() => { set({ list: false }); if (pageMatches(x.page, loc.pathname) || x.page === "/app") { if (x.page !== "/app" || loc.pathname === "/app") startTour(x); else { set({ pending: x }); navigate(x.page); } } else { set({ pending: x }); navigate(x.page); } }}>
                Start<span className="sr-only">{`: ${x.name}`}</span>
              </Button>
            </li>
          ))}
        </ul>
        {me.data?.organization && t.data?.canBuild && <p className="mt-3 text-[12.5px] text-muted">Build tours for your team in Settings, Tours.</p>}
      </Dialog>
    </>
  );
}
