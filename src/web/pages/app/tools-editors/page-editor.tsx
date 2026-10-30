/**
 * Tools P2, H7: page editor (Tools item 4). The engine draws every page small; the person drags pages
 * into a new order (mouse, touch or keyboard), turns them left or right, deletes them, undoes, and Save
 * runs the organize op with the plan. Drag and keyboard sorting come from @dnd-kit (already in Multies).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import {
  DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type Announcements, type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { IconRotate, IconTrash, IconUndo, IconGrip } from "@/web/components/ui/icon";
import { Button } from "@/web/components/ui/button";
import { Card } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";
import { EDITOR_MAX_PAGES, planSummary, turn, type EditorJob, type PlanEntry, type Rotation } from "@/shared/tools-editors";
import { readThumbnails, start, waitFor, RunError, type Source } from "./runner";
import { BusyLine, EditorFrame, ErrorCard, PdfPicker, ResultCard } from "./shell";

interface Item { id: string; page: number; rotate: Rotation }
type Phase = { kind: "pick" } | { kind: "loading"; pct: number | null } | { kind: "edit" } | { kind: "saving"; pct: number | null } | { kind: "done"; job: EditorJob } | { kind: "failed"; error: RunError; back: "pick" | "edit" };

const ROT_CLASS: Record<Rotation, string> = { 0: "", 90: "rotate-90", 180: "rotate-180", 270: "-rotate-90" };

function PageTile({ item, index, src, onTurn, onDelete, canDelete, disabled }: {
  item: Item; index: number; src: string | undefined; onTurn: (by: 90 | -90) => void; onDelete: () => void; canDelete: boolean; disabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const label = `Page ${item.page}${item.rotate ? `, turned ${item.rotate === 90 ? "right" : item.rotate === 270 ? "left" : "upside down"}` : ""}`;
  return (
    <li ref={setNodeRef} style={style} data-testid="page-tile" data-page={item.page} data-rotate={item.rotate}
      className={cn("group relative list-none rounded-xl border bg-elevated p-2 shadow-sm transition-shadow duration-150",
        isDragging ? "z-10 border-brand shadow-lg" : "border-line hover:border-line-strong")}>
      <button type="button" {...attributes} {...listeners} aria-label={`${label}. Position ${index + 1}. Press space to move.`} aria-roledescription="page you can move"
        className="block w-full cursor-grab touch-none rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-brand active:cursor-grabbing" disabled={disabled}>
        <span className="relative grid aspect-square w-full place-items-center overflow-hidden rounded-md bg-fill">
          {src ? <img src={src} alt="" draggable={false} className={cn("max-h-[80%] max-w-[80%] bg-white shadow-sm transition-transform duration-200 motion-reduce:transition-none", ROT_CLASS[item.rotate])} />
            : <span className="text-xs text-muted">Page {item.page}</span>}
          <IconGrip className="absolute left-1.5 top-1.5 h-4 w-4 text-subtle opacity-0 transition-opacity group-hover:opacity-100 max-sm:opacity-100" aria-hidden />
          <span className="absolute bottom-1.5 left-1.5 rounded-md bg-black/60 px-1.5 py-px text-[11px] font-medium tabular-nums text-white" aria-hidden>{index + 1}</span>
        </span>
      </button>
      <div className="mt-1.5 flex items-center justify-between gap-1">
        <span className="pl-1 text-[12px] tabular-nums text-subtle max-sm:hidden">{item.page !== index + 1 ? `Was page ${item.page}` : ""}</span>
        <span className="flex items-center opacity-100 transition-opacity max-sm:w-full max-sm:justify-between sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
          <button type="button" className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg max-sm:h-9 max-sm:w-9" aria-label={`Turn page ${item.page} left`} title="Turn left" onClick={() => onTurn(-90)} disabled={disabled}>
            <IconRotate className="h-3.5 w-3.5 -scale-x-100" aria-hidden /></button>
          <button type="button" className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg max-sm:h-9 max-sm:w-9" aria-label={`Turn page ${item.page} right`} title="Turn right" onClick={() => onTurn(90)} disabled={disabled}>
            <IconRotate className="h-3.5 w-3.5" aria-hidden /></button>
          <button type="button" className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-bad-soft hover:text-bad disabled:opacity-30 max-sm:h-9 max-sm:w-9" aria-label={`Delete page ${item.page}`} title="Delete" onClick={onDelete} disabled={disabled || !canDelete} data-testid="page-delete">
            <IconTrash className="h-3.5 w-3.5" aria-hidden /></button>
        </span>
      </div>
    </li>
  );
}

export function PageEditorPage() {
  const [params] = useSearchParams();
  const fromMail = params.get("attachment");
  const [src, setSrc] = useState<Source | null>(fromMail ? { kind: "attachment", id: fromMail, name: params.get("name") ?? "Attachment.pdf" } : null);
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [history, setHistory] = useState<Item[][]>([]);
  const [said, setSaid] = useState("");
  const stop = useRef({ stopped: false });
  const pageCount = thumbs.length;

  useEffect(() => () => { stop.current.stopped = true; }, []);
  useEffect(() => () => { for (const u of thumbs) URL.revokeObjectURL(u); }, [thumbs]);

  // Load the page previews as soon as there is a PDF.
  useEffect(() => {
    if (!src) { setPhase({ kind: "pick" }); return; }
    const signal = { stopped: false };
    stop.current = signal;
    setPhase({ kind: "loading", pct: src.kind === "file" ? 0 : null });
    (async () => {
      try {
        const job = await waitFor(await start("thumbnails", src, {}, (pct) => setPhase({ kind: "loading", pct })), () => undefined, signal);
        const urls = await readThumbnails(job);
        if (signal.stopped) { for (const u of urls) URL.revokeObjectURL(u); return; }
        if (!urls.length) throw new RunError("This PDF has no pages to show.");
        setThumbs(urls);
        const start0 = urls.map((_, i) => ({ id: `p${i + 1}`, page: i + 1, rotate: 0 as Rotation }));
        setItems(start0);
        setHistory([]);
        setPhase({ kind: "edit" });
      } catch (err) {
        if (!signal.stopped) setPhase({ kind: "failed", error: err instanceof RunError ? err : new RunError("The page previews could not be made."), back: "pick" });
      }
    })();
    return () => { signal.stopped = true; };
  }, [src]);

  const change = (next: Item[], words: string) => { setHistory((h) => [...h.slice(-49), items]); setItems(next); setSaid(words); };
  const undo = () => { const prev = history[history.length - 1]; if (!prev) return; setHistory((h) => h.slice(0, -1)); setItems(prev); setSaid("Undone."); };
  const reset = () => change(Array.from({ length: pageCount }, (_, i) => ({ id: `p${i + 1}`, page: i + 1, rotate: 0 as Rotation })), "Back to the original pages.");
  const turnAt = (i: number, by: 90 | -90) => change(items.map((it, k) => (k === i ? { ...it, rotate: turn(it.rotate, by) } : it)), `Page ${items[i].page} turned ${by === 90 ? "right" : "left"}.`);
  const turnAll = (by: 90 | -90) => change(items.map((it) => ({ ...it, rotate: turn(it.rotate, by) })), `Every page turned ${by === 90 ? "right" : "left"}.`);
  const deleteAt = (i: number) => { if (items.length <= 1) return; change(items.filter((_, k) => k !== i), `Page ${items[i].page} deleted.`); };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const pos = (id: string | number) => items.findIndex((x) => x.id === id) + 1;
  const pageOf = (id: string | number) => items.find((x) => x.id === id)?.page;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up page ${pageOf(active.id)}. Use the arrow keys to move it, space to drop it, escape to cancel.`,
    onDragOver: ({ active, over }) => (over ? `Page ${pageOf(active.id)} is over position ${pos(over.id)}.` : `Page ${pageOf(active.id)} is not over a position.`),
    onDragEnd: ({ active, over }) => (over ? `Page ${pageOf(active.id)} dropped at position ${pos(over.id)}.` : `Page ${pageOf(active.id)} dropped.`),
    onDragCancel: ({ active }) => `Moving page ${pageOf(active.id)} cancelled.`,
  };
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = items.findIndex((x) => x.id === active.id), to = items.findIndex((x) => x.id === over.id);
    change(arrayMove(items, from, to), `Page ${items[from].page} moved to position ${to + 1}.`);
  };

  const plan: PlanEntry[] = useMemo(() => items.map((i) => ({ page: i.page, rotate: i.rotate })), [items]);
  const summary = planSummary(plan, pageCount);
  const unchanged = summary === "No changes yet";

  const save = async () => {
    if (!src) return;
    const signal = { stopped: false };
    stop.current = signal;
    setPhase({ kind: "saving", pct: src.kind === "file" ? 0 : null });
    try {
      const job = await waitFor(await start("organize", src, { plan: JSON.stringify(plan) }, (pct) => setPhase({ kind: "saving", pct })), () => undefined, signal);
      setPhase({ kind: "done", job });
    } catch (err) {
      if (!signal.stopped) setPhase({ kind: "failed", error: err instanceof RunError ? err : new RunError("That didn't work. Try again."), back: "edit" });
    }
  };
  const again = () => { setSrc(null); setThumbs([]); setItems([]); setHistory([]); setPhase({ kind: "pick" }); };
  const busy = phase.kind === "loading" || phase.kind === "saving";

  return (
    <EditorFrame feature="editor" title="Edit pages" description="See every page, then drag to reorder, turn or delete pages. Save makes a new PDF; the original is not changed." testId="page-editor">
      {phase.kind !== "done" && (
        <Card className="space-y-4 p-4">
          <PdfPicker label="PDF to edit" value={src} onChange={(s) => setSrc(s)} disabled={busy} testId="page-editor-pdf" hint={`Drop a PDF here (up to ${EDITOR_MAX_PAGES} pages), or`} />
          {phase.kind === "loading" && <BusyLine>{phase.pct !== null && phase.pct < 100 ? `Uploading ${phase.pct}%` : "Drawing the pages"}</BusyLine>}
        </Card>
      )}

      {(phase.kind === "edit" || phase.kind === "saving" || (phase.kind === "failed" && phase.back === "edit")) && items.length > 0 && (
        <Card className="space-y-4 p-4" data-testid="page-grid-card">
          <div className="no-scrollbar flex flex-wrap items-center gap-2 max-sm:-mx-4 max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:px-4">
            <Button type="button" variant="outline" size="sm" onClick={undo} disabled={!history.length || busy} data-testid="page-undo"><IconUndo className="h-3.5 w-3.5" aria-hidden />Undo</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => turnAll(-90)} disabled={busy}><IconRotate className="h-3.5 w-3.5 -scale-x-100" aria-hidden />Turn all left</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => turnAll(90)} disabled={busy}><IconRotate className="h-3.5 w-3.5" aria-hidden />Turn all right</Button>
            <Button type="button" variant="ghost" size="sm" onClick={reset} disabled={busy || unchanged}>Start over</Button>
            <span className="ml-auto text-[13px] text-muted" data-testid="page-summary">{summary}</span>
          </div>
          <p className="text-[12.5px] text-muted max-sm:hidden">Drag a page to move it. With the keyboard, focus a page, press space, use the arrow keys, then space again.</p>
          <p className="text-[12.5px] text-muted sm:hidden">Press and hold a page, then drag it.</p>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} accessibility={{ announcements, screenReaderInstructions: { draggable: "To move a page, press space. Use the arrow keys to move it, space to drop it, escape to cancel." } }}>
            <SortableContext items={items.map((i) => i.id)} strategy={rectSortingStrategy}>
              <ol className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5" aria-label="Pages" data-testid="page-grid">
                {items.map((it, i) => (
                  <PageTile key={it.id} item={it} index={i} src={thumbs[it.page - 1]} onTurn={(by) => turnAt(i, by)} onDelete={() => deleteAt(i)} canDelete={items.length > 1} disabled={busy} />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
          <div className="sr-only" aria-live="polite">{said}</div>
          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4 max-sm:sticky max-sm:bottom-0 max-sm:z-10 max-sm:-mx-4 max-sm:-mb-4 max-sm:rounded-b-[inherit] max-sm:bg-surface/95 max-sm:px-4 max-sm:pb-[max(12px,env(safe-area-inset-bottom))] max-sm:backdrop-blur">
            <Button type="button" onClick={save} disabled={busy || unchanged} loading={phase.kind === "saving"} data-testid="page-save" className="max-sm:w-full">Save as new PDF</Button>
            {phase.kind === "saving" && <BusyLine>{phase.pct !== null && phase.pct < 100 ? `Uploading ${phase.pct}%` : "Saving"}</BusyLine>}
            {unchanged && phase.kind === "edit" && <span className="text-[13px] text-muted">Move, turn or delete a page to save.</span>}
          </div>
        </Card>
      )}

      {phase.kind === "failed" && <ErrorCard error={phase.error} onRetry={phase.back === "pick" ? again : () => setPhase({ kind: "edit" })} />}
      {phase.kind === "done" && <ResultCard job={phase.job} facts={phase.job.result?.pages ? `${phase.job.result.pages} ${phase.job.result.pages === 1 ? "page" : "pages"}.` : summary} onAgain={again} />}
    </EditorFrame>
  );
}
