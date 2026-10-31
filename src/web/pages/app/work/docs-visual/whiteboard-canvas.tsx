/**
 * R89: the live board (its own chunk; loads only when a board is on screen). The drawing library draws; this
 * file keeps it in step with everyone else:
 * - Elements live in the shared document's map "wb:<board id>", one entry per element. Local changes write only
 *   the elements whose version moved; remote changes are merged element by element (higher version wins), so two
 *   people drawing at once never overwrite each other.
 * - Cursors: each client puts its pointer, name and colour in the room's presence under "wb"; others draw them.
 * - Saving: the leader (or the only editor) hands a snapshot back to the doc block about a second after a change,
 *   and the doc's own save loop writes it to the row.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { CaptureUpdateAction, Excalidraw, MainMenu, WelcomeScreen, exportToBlob, exportToSvg, reconcileElements, restoreElements } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { toast } from "sonner";
import type { CollabSession } from "../doc-collab";
import { isLeader } from "../doc-collab";
import { showError } from "@/web/lib/show-error";
import { changedSince, mergeElements, orderElements, readScene, snapshotElements, MAX_BOARD_BYTES, type BoardElement } from "@/web/lib/whiteboard-merge";
import { downloadBlob, safeName } from "./export-file";

/* eslint-disable @typescript-eslint/no-explicit-any -- the drawing library's element and API types are wide unions */
type Api = any;

export interface CanvasProps {
  boardId: string;
  scene: string;
  session: CollabSession | null;
  readOnly: boolean;
  dark: boolean;
  user: { name: string; color: string };
  title: string;
  onSnapshot: (scene: string) => void;
  onReady?: () => void;
  exportRef?: React.MutableRefObject<((kind: "png" | "svg") => Promise<void>) | null>;
}

const LOCAL = "wb-local";
const dbg = (...a: unknown[]) => { if (typeof localStorage !== "undefined" && localStorage.getItem("mm-debug-board")) console.log("[board]", ...a); };
const SNAPSHOT_MS = 1100;

export default function WhiteboardCanvas(p: CanvasProps) {
  const apiRef = useRef<Api>(null);
  const host = useRef<HTMLDivElement>(null);
  /** The count of drawn elements on the wrapper: a cheap, visible fact for tests and for screen readers' summary. */
  const mark = (els: readonly BoardElement[]) => { const n = els.filter((e) => !e.isDeleted).length; host.current?.setAttribute("data-element-count", String(n)); host.current?.setAttribute("aria-label", n ? `Whiteboard with ${n} ${n === 1 ? "shape" : "shapes"}` : "Empty whiteboard"); };
  const [api, setApi] = useState<Api>(null);
  const sent = useRef(new Map<string, number>());
  const snapTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastSnap = useRef(p.scene);
  const props = useRef(p);
  props.current = p;
  const warned = useRef(false);
  // A board without a room still uses a shared map, local to this page, so one code path does both.
  const localDoc = useMemo(() => new Y.Doc(), []);
  const ydoc = p.session?.ydoc ?? localDoc;
  const ymap = useMemo(() => ydoc.getMap<BoardElement>(`wb:${p.boardId}`), [ydoc, p.boardId]);
  useEffect(() => { dbg("mount", p.boardId, !!p.session); return () => { dbg("unmount"); localDoc.destroy(); }; }, [localDoc]); // eslint-disable-line react-hooks/exhaustive-deps

  const all = useCallback((): BoardElement[] => orderElements([...ymap.values()]), [ymap]);

  const snapshotSoon = useCallback(() => {
    if (props.current.readOnly) return;
    clearTimeout(snapTimer.current);
    snapTimer.current = setTimeout(() => {
      const s = props.current.session;
      if (s && !isLeader(s)) return;
      const json = JSON.stringify(snapshotElements(all()));
      if (json === lastSnap.current) return;
      if (json.length > MAX_BOARD_BYTES) {
        if (!warned.current) { warned.current = true; toast.error("This board is too big to save. Remove some drawings or split it into two boards."); }
        return;
      }
      lastSnap.current = json;
      props.current.onSnapshot(json);
    }, SNAPSHOT_MS);
  }, [all]);

  // Seed the shared map from the saved copy (once, when the room has no drawing yet). The first drawing goes in as
  // the library's initial data: a scene set before it has loaded is replaced by its own empty start.
  const initial = useMemo(() => {
    const saved = readScene(p.scene);
    if (ymap.size === 0 && saved.length && !p.readOnly) ydoc.transact(() => { for (const e of saved) if (!ymap.has(e.id)) ymap.set(e.id, e); }, LOCAL);
    const start = ymap.size ? orderElements([...ymap.values()]) : saved;
    return restoreElements(start as any, null, { refreshDimensions: false, repairBindings: true }) as unknown as BoardElement[];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const initialData = useMemo(() => ({ elements: initial as any, scrollToContent: true, appState: { viewBackgroundColor: "transparent" } }), [initial]);

  // Once loaded: take anything that reached the room meanwhile, and note what is already shared.
  useEffect(() => {
    if (!api) return;
    let raf = 0, tries = 0, live = true;
    const ready = () => {
      if (!live) return;
      if (api.getAppState()?.isLoading && tries++ < 120) { raf = requestAnimationFrame(ready); return; }
      const local = api.getSceneElementsIncludingDeleted() as BoardElement[];
      const merged = mergeElements(local.length ? local : initial, [...ymap.values()]);
      sent.current = new Map(merged.map((e) => [e.id, e.version]));
      if (merged.length !== local.length || merged.some((e, i) => local[i]?.id !== e.id || local[i]?.version !== e.version)) {
        api.updateScene({ elements: restoreElements(merged as any, null), captureUpdate: CaptureUpdateAction.NEVER });
      }
      mark(merged);
      p.onReady?.();
    };
    ready();
    return () => { live = false; cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // Remote changes: merge element by element into what is on screen.
  useEffect(() => {
    if (!api) return;
    const onChange = (ev: Y.YMapEvent<BoardElement>, tr: Y.Transaction) => {
      if (tr.origin === LOCAL) return;
      const remote: BoardElement[] = [];
      ev.keysChanged.forEach((k) => { const e = ymap.get(k); if (e) remote.push(e); });
      dbg("remote", remote.map((e) => `${e.id}:${e.version}`).join(","));
      if (!remote.length) return;
      const local = api.getSceneElementsIncludingDeleted() as BoardElement[];
      let next: BoardElement[];
      try {
        next = reconcileElements(local as any, restoreElements(remote as any, null) as any, api.getAppState()) as unknown as BoardElement[];
      } catch {
        next = mergeElements(local, remote);
      }
      dbg("merged", local.length, "->", next.length);
      // Only what came from the room counts as shared; a local stroke still in progress keeps its own count, so its
      // next change is written (marking it here lost strokes drawn while someone else drew).
      const byId = new Map(next.map((e) => [e.id, e]));
      for (const r of remote) { const e = byId.get(r.id); if (e && e.version === r.version) sent.current.set(r.id, r.version); }
      api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER });
      mark(next);
      snapshotSoon();
    };
    ymap.observe(onChange);
    return () => ymap.unobserve(onChange);
  }, [api, ymap, snapshotSoon]);

  // Cursors and selections of the others on this board.
  useEffect(() => {
    const s = p.session;
    if (!api || !s) return;
    const aw = s.provider.awareness;
    const paint = () => {
      const collaborators = new Map<string, any>();
      aw.getStates().forEach((state: any, id: number) => {
        const wb = state?.wb;
        if (id === s.ydoc.clientID || !wb || wb.board !== p.boardId) return;
        collaborators.set(String(id), { id: String(id), socketId: String(id), username: wb.name, pointer: wb.pointer, button: wb.button ?? "up", selectedElementIds: wb.selected ?? {}, color: { background: wb.color, stroke: wb.color } });
      });
      api.updateScene({ collaborators, captureUpdate: CaptureUpdateAction.NEVER });
    };
    aw.on("change", paint);
    paint();
    return () => {
      aw.off("change", paint);
      aw.setLocalStateField("wb", null);
    };
  }, [api, p.session, p.boardId]);

  const lastPointer = useRef(0);
  const onPointerUpdate = useCallback((payload: { pointer: { x: number; y: number; tool: string }; button: "down" | "up" }) => {
    const s = props.current.session;
    if (!s) return;
    const now = performance.now();
    if (now - lastPointer.current < 40) return;
    lastPointer.current = now;
    const sel = apiRef.current?.getAppState()?.selectedElementIds ?? {};
    s.provider.awareness.setLocalStateField("wb", { board: props.current.boardId, pointer: { x: payload.pointer.x, y: payload.pointer.y, tool: payload.pointer.tool }, button: payload.button, selected: sel, name: props.current.user.name, color: props.current.user.color });
  }, []);

  const onChange = useCallback((elements: readonly BoardElement[]) => {
    mark(elements);
    if (props.current.readOnly) return;
    const changed = changedSince(sent.current, elements);
    if (!changed.length) return;
    dbg("local", changed.map((e) => `${e.id}:${e.version}`).join(","), "ymap", ymap.size);
    ydoc.transact(() => {
      for (const e of changed) {
        const cur = ymap.get(e.id);
        if (!cur || cur.version !== e.version || cur.versionNonce !== e.versionNonce) {
          if (!cur || e.version >= cur.version) ymap.set(e.id, JSON.parse(JSON.stringify(e)) as BoardElement);
        }
        sent.current.set(e.id, e.version);
      }
    }, LOCAL);
    snapshotSoon();
  }, [ydoc, ymap, snapshotSoon]);

  // Exports for the block's own buttons.
  useEffect(() => {
    if (!p.exportRef) return;
    p.exportRef.current = async (kind) => {
      const a = apiRef.current;
      if (!a) return;
      const elements = a.getSceneElements();
      if (!elements.length) { toast("Draw something first"); return; }
      const appState = { ...a.getAppState(), exportBackground: true, viewBackgroundColor: "#ffffff", exportWithDarkMode: props.current.dark, exportScale: 2 };
      try {
        if (kind === "png") downloadBlob(await exportToBlob({ elements, appState, files: a.getFiles(), mimeType: "image/png", exportPadding: 24 }), safeName(props.current.title, "png"));
        else {
          const svg = await exportToSvg({ elements, appState, files: a.getFiles(), exportPadding: 24 });
          downloadBlob(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }), safeName(props.current.title, "svg"));
        }
        toast.success(kind === "png" ? "Saved as PNG" : "Saved as SVG");
      } catch (e) { showError(e as Error); }
    };
    return () => { if (p.exportRef) p.exportRef.current = null; };
  }, [p.exportRef]);

  useEffect(() => () => clearTimeout(snapTimer.current), []);
  // Save what is pending when the board closes (leaving the page, closing the block).
  useEffect(() => () => {
    if (props.current.readOnly) return;
    const s = props.current.session;
    if (s && !isLeader(s)) return;
    const json = JSON.stringify(snapshotElements(all()));
    if (json !== lastSnap.current && json.length <= MAX_BOARD_BYTES) props.current.onSnapshot(json);
  }, [all]);

  return (
    <div ref={host} className="h-full w-full" role="region" aria-label="Whiteboard" data-testid="board-host" data-element-count="0">
    <Excalidraw
      excalidrawAPI={(a: Api) => { apiRef.current = a; setApi(a); }}
      initialData={initialData}
      onChange={onChange as any}
      onPointerUpdate={onPointerUpdate as any}
      isCollaborating={!!p.session}
      viewModeEnabled={p.readOnly}
      theme={p.dark ? "dark" : "light"}
      name={p.title}
      langCode="en"
      detectScroll
      handleKeyboardGlobally={false}
      autoFocus={false}
      UIOptions={{
        canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: null, changeViewBackgroundColor: !p.readOnly, clearCanvas: !p.readOnly },
        tools: { image: false },
      }}
    >
      <MainMenu>
        <MainMenu.Item onSelect={() => void p.exportRef?.current?.("png")}>Download PNG</MainMenu.Item>
        <MainMenu.Item onSelect={() => void p.exportRef?.current?.("svg")}>Download SVG</MainMenu.Item>
        {!p.readOnly && <MainMenu.DefaultItems.ClearCanvas />}
        {!p.readOnly && <MainMenu.DefaultItems.ChangeCanvasBackground />}
      </MainMenu>
      <WelcomeScreen>
        <WelcomeScreen.Hints.ToolbarHint>Pick a tool and start drawing</WelcomeScreen.Hints.ToolbarHint>
        <WelcomeScreen.Center>
          <WelcomeScreen.Center.Heading>{p.readOnly ? "Nothing on this board yet" : "Draw, write and arrange ideas together"}</WelcomeScreen.Center.Heading>
        </WelcomeScreen.Center>
      </WelcomeScreen>
    </Excalidraw>
    </div>
  );
}
