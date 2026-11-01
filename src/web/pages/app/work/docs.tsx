import { NoDocsArt, NoSearchResultsArt } from "@/web/components/illustrations";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { lazyPage } from "@/web/components/lazy-page";
import { toast } from "sonner";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { NewTableDialog, TableDoc, useTablesOn } from "./tables-r125";
import { CatchupCard } from "@/web/components/catchup-card"; // R31
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Transaction } from "@tiptap/pm/state";
import { IconArrowLeft, IconBold, IconDocs, IconDownload, IconHeading2, IconItalic, IconLink, IconList, IconListOrdered, IconPlay, IconPlus, IconQuote, IconShapes, IconBook, IconTable, IconTasks, IconTemplate, IconTrash, IconUser } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { useDialogs } from "@/web/components/ui/confirm";
import { Input } from "@/web/components/ui/input";
import { EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { useConfig, useMe } from "@/web/lib/queries";
import { colourFor, meta, type CollabSession } from "./doc-collab";
import { docExtensions, liveDomEvents, liveKeyDown, useCollabDoc, useCollabSession } from "./collab-editor";
import { tone } from "@/web/components/app-bits";
import { MeetingNotesBacklink } from "./meeting-notes";
import { ShareButton } from "./share-sheet"; // R26 (MB-87)
import { SlashMenu } from "./slash-menu"; // R31: "/" menu for every block
import { uploadDocImage } from "@/web/lib/docs-blocks"; // R32: table, image and callout blocks
import { ImageInsertDialog, ImageToolbar, TableMenu } from "./doc-block-menus";
import { DocBreadcrumbs, DocTreeSidebar, LinkedFrom, PageLinkPicker, deleteDocConfirm, useBracketTrigger, useDocTree } from "./doc-tree";
import { recordRecent } from "@/web/lib/palette-recents"; // R36
import { DocHistoryButton, DocHistoryPanel } from "./doc-history-r39"; // R39: page history
import { docKindOf, whiteboardDocContent } from "@/shared/docs-visual"; // R89: whiteboards, mind map, Present
import { pageBoardExport } from "./docs-visual/whiteboard-view";
import type { PMNode } from "@/web/lib/mindmap-tree";
import { DocCommentsButton, DocCommentsPanel } from "./doc-comments-r103"; // R103
import { CourseDoc, NewCourseDialog, useCoursesOn } from "./courses-r129"; // R129
import { SpellButton } from "@/web/components/spell-check-r103";
import { SpellAttrs, fixInEditor } from "./doc-spell-r103";
import { LoadError } from "@/web/components/load-error-t1g"; // T1G (T1-8)
import { isServerLoadError } from "@/web/lib/load-errors-t1g";

const MindMapView = lazyPage(() => import("./docs-visual/mindmap-view"), "MindMapView");
const PresentOverlay = lazyPage(() => import("./docs-visual/present"), "PresentOverlay");
const PresenterWindow = lazyPage(() => import("./docs-visual/present"), "PresenterWindow");

interface DocSummary { id: string; title: string; excerpt: string; updatedAt: string; projectId: string | null; kind?: "doc" | "whiteboard" | "table" | "course" }
interface Doc extends DocSummary { content: Record<string, unknown>; text: string; version: number; links: { type: string; id: string }[] }
type DocMode = "doc" | "mindmap";

export function DocsPage() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const docs = useQuery({ queryKey: ["docs", q], queryFn: async () => (await api.get<{ docs: DocSummary[] }>(`/docs${q ? `?q=${encodeURIComponent(q)}` : ""}`)).docs });
  const visual = useConfig().data?.docsVisual !== false; // R89
  const create = async (kind: "doc" | "whiteboard" = "doc") => {
    try {
      const r = await api.post<{ doc: Doc }>("/docs", kind === "whiteboard" ? { title: "Untitled whiteboard", content: whiteboardDocContent() } : { title: "Untitled", text: "" });
      navigate(`/app/docs/${r.doc.id}`);
    } catch (e) { showError(e as Error); }
  };
  // R30: /app/docs?new=1 (from the command menu) starts a new doc once, then opens it. R89: ?new=whiteboard.
  const [params] = useSearchParams();
  const started = useRef(false);
  const tablesOn = useTablesOn(); // R125
  const [newTable, setNewTable] = useState(false);
  const coursesOn = useCoursesOn(); // R129
  const [newCourse, setNewCourse] = useState(false);
  useEffect(() => {
    const n = params.get("new");
    if (n === "table" && tablesOn && !started.current) { started.current = true; setNewTable(true); return; }
    if (n === "course" && coursesOn && !started.current) { started.current = true; setNewCourse(true); return; } // R129
    if ((n !== "1" && n !== "whiteboard") || started.current) return;
    started.current = true;
    void create(n === "whiteboard" ? "whiteboard" : "doc");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, tablesOn, coursesOn]);
  return (
    <div className="flex gap-6">
      {newTable && <NewTableDialog open onClose={() => setNewTable(false)} />}
      <DocTreeSidebar />
      <div className="min-w-0 flex-1">
      {newCourse && <NewCourseDialog open onClose={() => setNewCourse(false)} />}
      <PageHeader title="Docs" description="Briefs, meeting notes and plans, linked to tasks, projects, threads and contacts. Agents can read and add to them too." actions={<div className="flex flex-wrap gap-2">{coursesOn && <Link to="/app/docs/learning" className="inline-flex min-h-9 items-center rounded-lg px-3 text-[14px] font-medium text-muted hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand" data-testid="my-learning-link">My learning</Link>}{coursesOn && <Button variant="secondary" onClick={() => setNewCourse(true)} data-testid="new-course"><IconBook className="h-4 w-4" />New course</Button>}{tablesOn && <Button variant="secondary" onClick={() => setNewTable(true)} data-testid="new-table"><IconTable className="h-4 w-4" />New table</Button>}{visual && <Button variant="secondary" onClick={() => void create("whiteboard")} data-testid="new-whiteboard"><IconShapes className="h-4 w-4" />New whiteboard</Button>}<Button onClick={() => void create()}><IconPlus className="h-4 w-4" />New doc</Button></div>} />
      <Input aria-label="Search docs" placeholder="Search docs" value={q} onChange={(e) => setQ(e.target.value)} className="mb-4 max-w-sm" />
      {docs.isError && !docs.data ? <LoadError onRetry={() => docs.refetch()} /> : docs.isPending ? <Skeleton className="h-40" /> : !docs.data?.length ? (
        <EmptyState icon={<IconDocs />} art={q ? <NoSearchResultsArt /> : <NoDocsArt />} title={q ? "No docs match" : "No docs yet"} body="Write a brief or notes and link it to the work it belongs to." action={!q && <Button onClick={() => void create()}>New doc</Button>} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="doc-list">
          {docs.data.map((d) => (
            <li key={d.id}><Link to={`/app/docs/${d.id}`} className="block h-full rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong">
              <div className="flex items-center gap-2 text-[14px] font-medium">{d.kind === "course" ? <IconBook className="h-4 w-4 text-muted" aria-label="Course" /> : d.kind === "table" ? <IconTable className="h-4 w-4 text-muted" aria-label="Table" /> : d.kind === "whiteboard" ? <IconShapes className="h-4 w-4 text-muted" aria-label="Whiteboard" /> : <IconDocs className="h-4 w-4 text-muted" />}{d.title}</div>
              <p className="mt-2 line-clamp-3 whitespace-pre-line text-[13px] leading-relaxed text-muted">{d.excerpt || "Empty"}</p>
              <p className="mt-3 text-[12px] text-subtle">Edited {timeAgo(d.updatedAt)}</p>
            </Link></li>
          ))}
        </ul>
      )}
      </div>
    </div>
  );
}

function ToolButton({ on, label, active, children }: { on: () => void; label: string; active?: boolean; children: React.ReactNode }) {
  return <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={on} aria-label={label} aria-pressed={active} title={label}
    className={cn("inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-muted transition-colors duration-150 ease-out hover:bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:h-11 max-sm:w-11 max-sm:rounded-lg [&_svg]:h-4 [&_svg]:w-4 max-sm:[&_svg]:h-5 max-sm:[&_svg]:w-5", active && "bg-brand-soft text-brand-hover hover:bg-brand-soft hover:text-brand-hover")}>{children}</button>;
}

export function DocPage() {
  // R89: the presenter's second window shows only the presenter view (and never joins the room, so it can not
  // become the client that saves).
  const [sp] = useSearchParams();
  return sp.get("present") === "presenter" ? <PresenterDoc start={Number(sp.get("slide")) || 0} /> : <DocPageMain />;
}

function PresenterDoc({ start }: { start: number }) {
  const { id = "" } = useParams();
  const q = useQuery({ queryKey: ["doc", id], queryFn: async () => (await api.get<{ doc: Doc }>(`/docs/${id}`)).doc, refetchOnWindowFocus: false });
  if (!q.data && q.isError) return <div className="p-6"><LoadError onRetry={() => q.refetch()} /></div>; // T1G (T1-8)
  if (!q.data) return <div className="p-6"><Skeleton className="h-64" /></div>;
  return <Suspense fallback={null}><PresenterWindow docId={id} doc={q.data.content as unknown as PMNode} title={q.data.title} start={start} /></Suspense>;
}

function DocPageMain() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["doc", id], queryFn: async () => (await api.get<{ doc: Doc }>(`/docs/${id}`)).doc, refetchOnWindowFocus: false });
  // Co-editing when the room answers; otherwise the single person editor.
  const collab = useCollabSession(id);
  // R39: a restore from page history replaces the page; the editor starts again from the restored doc.
  const qc = useQueryClient();
  const [replaced, setReplaced] = useState(0);
  const onReplaced = useCallback((d: Doc) => { qc.setQueryData(["doc", id], d); setReplaced((n) => n + 1); }, [qc, id]);

  // R129: a course doc is its own page (learn, build, assign, progress). R125: a table doc is its own page (grid, kanban, calendar, form) instead of the text editor.
  const body = (q.data as { kind?: string } | undefined)?.kind === "course" ? <CourseDoc docId={id} /> : q.data?.kind === "table" ? <TableDoc docId={id} /> : q.isPending || !collab ? <div className="mx-auto max-w-3xl space-y-3"><Skeleton className="h-9 w-1/2" /><Skeleton className="h-64" /></div>
    : q.error && !isServerLoadError(q.error) ? <EmptyState icon={<IconDocs />} title="Doc not found" body="It may have been deleted." action={<Button onClick={() => navigate("/app/docs")}>All docs</Button>} />
    : q.data === undefined ? <LoadError onRetry={() => q.refetch()} /> // T1G (T1-8): a server failure is not "not found"
    : <DocEditor key={`${id}:${collab.session ? "live" : "solo"}:${replaced}`} doc={q.data} session={collab.session} onReplaced={onReplaced} />;
  // R24.5: the page tree beside the doc.
  return <div className="flex gap-6"><DocTreeSidebar currentId={id} /><div className="min-w-0 flex-1">{body}</div></div>;
}

const EDITOR_PROPS = { attributes: { class: "mm-prose min-h-[50vh] outline-none", "aria-label": "Doc body", role: "textbox", "aria-multiline": "true" } };

const LIVE_EDITOR_PROPS = { ...EDITOR_PROPS, handleKeyDown: liveKeyDown, handleDOMEvents: liveDomEvents };

// R89: a whiteboard doc is one board; typing outside the board (into the hidden lines around it) is ignored, and
// keys can not delete the board itself.
const BOARD_KEYS = new Set(["Enter", "Backspace", "Delete"]);
const BOARD_PROPS = { attributes: { class: "mm-board-doc outline-none", "aria-label": "Whiteboard" }, handleTextInput: () => true, handlePaste: () => true, handleDrop: () => true, handleKeyDown: (_v: unknown, e: KeyboardEvent) => BOARD_KEYS.has(e.key) };
const LIVE_BOARD_PROPS = { ...BOARD_PROPS, handleDOMEvents: liveDomEvents };

function DocEditor({ doc, session, onReplaced }: { doc: Doc; session: CollabSession | null; onReplaced: (d: Doc) => void }) {
  const docsPlus = !!useConfig().data?.docsPlus; // R103
  const [commentsOpen, setCommentsOpen] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("comments") === "1");
  // R36: an opened doc joins "Recently opened" in the command menu (device only, no server write).
  useEffect(() => { recordRecent({ kind: "item", id: `/app/docs/${doc.id}`, label: doc.title || "Untitled", url: `/app/docs/${doc.id}`, hint: "Doc" }); }, [doc.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const { confirm, dialogs } = useDialogs();
  const id = doc.id;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useMe();
  const [title, setTitle] = useState(doc.title);
  const onUpdate = useRef<(tr?: Transaction) => void>(() => {});
  const userName = me.data?.user.name || me.data?.user.email || "Someone";
  const userColour = colourFor(me.data?.user.id ?? userName);
  // Stable options: a new extensions array or editorProps object on a render makes Tiptap
  // reconfigure the view, which redraws the shared document and drops the cursor.
  // R89: boards and diagrams read the title (file names) and the person's name and colour (cursors) through refs.
  const titleRef = useRef(title);
  titleRef.current = title;
  const userRef = useRef({ name: userName, color: userColour });
  userRef.current = { name: userName, color: userColour };
  const extensions = useMemo(() => docExtensions(session, { upload: (f: File) => uploadDocImage(id, f), onError: showError }, { title: () => titleRef.current, user: () => userRef.current }), [session, id]);
  const isBoard = (doc.kind ?? docKindOf(doc.content)) === "whiteboard";
  const editor = useEditor({
    extensions,
    // No content key at all in a live session: the room is the content, and an option
    // that differs from the editor's own makes Tiptap reconfigure on every render.
    ...(session ? {} : { content: doc.content as never }),
    editorProps: isBoard ? (session ? LIVE_BOARD_PROPS : BOARD_PROPS) : session ? LIVE_EDITOR_PROPS : EDITOR_PROPS,
    onUpdate: ({ transaction }) => onUpdate.current(transaction),
    immediatelyRender: true,
  });

  // The save loop (leader only when live) is shared with the meeting notes: collab-editor.ts.
  const { state, peers, save, schedule, saved, timer } = useCollabDoc({
    doc, session, editor, delayMs: 900, user: { name: userName, color: userColour },
    soloExtra: () => ({ title }),
    onSaved: () => {
      void qc.invalidateQueries({ queryKey: ["docs"] });
      void qc.invalidateQueries({ queryKey: ["doc-tree"] }); // R24.5: titles in the tree
      void qc.invalidateQueries({ queryKey: ["backlinks"] });
    },
  });
  onUpdate.current = schedule;

  const saveTitle = async () => {
    if (!session) { if (title !== doc.title) void save({ title }); return; }
    const m = meta(session.ydoc);
    if (title === doc.title && title === (m.get("title") ?? doc.title)) return;
    try { saved((await api.patch<{ doc: Doc }>(`/docs/${id}`, { title })).doc); } catch (e) { showError(e as Error); }
  };

  // Live session: follow the shared title.
  useEffect(() => {
    if (!session) return;
    const m = meta(session.ydoc);
    const onMeta = () => { const t = m.get("title"); if (typeof t === "string") setTitle(t); };
    m.observe(onMeta);
    onMeta();
    return () => m.unobserve(onMeta);
  }, [session]);

  const e = editor;
  const tree = useDocTree();
  const [picker, setPicker] = useState(false);
  const openPicker = useCallback(() => setPicker(true), []);
  const [imageDialog, setImageDialog] = useState(false);
  const openImageDialog = useCallback(() => setImageDialog(true), []);
  const uploadImage = useCallback((f: File) => uploadDocImage(id, f), [id]);
  useBracketTrigger(editor, openPicker);
  const [history, setHistory] = useState(false); // R39: page history panel
  const openHistory = useCallback(() => setHistory(true), []);
  // R89: mind map mode (?mode=mindmap) and Present (?present=1), both off the same editor.
  const visual = useConfig().data?.docsVisual !== false;
  const [sp, setSp] = useSearchParams();
  const mode: DocMode = visual && !isBoard && sp.get("mode") === "mindmap" ? "mindmap" : "doc";
  const presenting = visual && !isBoard && sp.get("present") === "1";
  const setParam = (k: string, v: string | null) => setSp((p) => { const n = new URLSearchParams(p); if (v === null) n.delete(k); else n.set(k, v); return n; }, { replace: true });
  const status = state === "saving" ? "Saving" : state === "unsaved" ? "Unsaved changes" : state === "conflict" ? "Changed elsewhere. Reload to see the latest." : "Saved";
  return (
    <div className={cn("mx-auto", isBoard ? "max-w-none" : mode === "mindmap" ? "max-w-6xl" : "max-w-3xl")} data-doc-kind={isBoard ? "whiteboard" : "doc"} data-mode={mode}>
      {dialogs}
      <div className="mb-3 flex items-center gap-2 text-[12.5px] text-subtle max-sm:-mx-2 max-sm:-mt-3 max-sm:mb-1 max-sm:gap-0" data-testid="doc-bar">
        <Link to="/app/docs" className="inline-flex items-center gap-1 hover:text-fg max-sm:h-11 max-sm:shrink-0 max-sm:gap-0.5 max-sm:rounded-lg max-sm:pl-1 max-sm:pr-2 max-sm:text-[16px] max-sm:text-brand-hover max-sm:active:bg-hover"><IconArrowLeft className="h-3.5 w-3.5 max-sm:h-5 max-sm:w-5" />Docs</Link>
        {session && (
          <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5 max-sm:mr-1" data-testid="collab-presence" aria-label={peers.length ? `Also here: ${peers.map((p) => p.name).join(", ")}` : "Only you are here"}>
            <span className="inline-flex items-center gap-1 text-[12px]"><span className="h-1.5 w-1.5 rounded-full bg-good max-sm:h-2 max-sm:w-2" aria-hidden /><span className="max-sm:sr-only">Live</span></span>
            {peers.map((p) => (
              <span key={p.clientId} data-testid="collab-peer" title={p.name} className="inline-flex max-w-[10rem] items-center gap-1 whitespace-nowrap rounded-full border border-line px-2 py-0.5 text-[12px] text-fg">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: tone(p.color) }} aria-hidden /><span className="truncate">{p.name.split(" ")[0]}</span>
              </span>
            ))}
          </div>
        )}
        <span className={cn(!session && "ml-auto", "shrink-0 whitespace-nowrap max-sm:mr-1", state === "saved" && "max-sm:sr-only", state === "conflict" && "max-sm:order-last max-sm:basis-full max-sm:whitespace-normal max-sm:px-2 max-sm:pt-1 max-sm:text-bad")} role="status">{status}</span>
        {visual && !isBoard && (
          <div role="group" aria-label="View" className="inline-flex shrink-0 rounded-lg border border-line p-0.5 max-sm:hidden" data-testid="doc-mode">
            {(["doc", "mindmap"] as DocMode[]).map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => setParam("mode", m === "doc" ? null : "mindmap")}
                className={cn("rounded-md px-2 py-0.5 text-[12.5px] transition-colors duration-150", mode === m ? "bg-brand-soft font-medium text-brand-hover" : "text-muted hover:text-fg")}>{m === "doc" ? "Doc" : "Mind map"}</button>
            ))}
          </div>
        )}
        {visual && !isBoard && (
          <button type="button" aria-label="Present" title="Present" data-testid="present-button" onClick={() => setParam("present", "1")}
            className="inline-flex shrink-0 items-center justify-center gap-1 rounded px-1.5 py-1 hover:bg-hover hover:text-fg max-sm:h-11 max-sm:min-w-11 max-sm:rounded-lg">
            <IconPlay className="h-4 w-4 max-sm:h-5 max-sm:w-5" /><span className="max-lg:hidden">Present</span>
          </button>
        )}
        {isBoard && (
          <>
            <button type="button" aria-label="Download as PNG" onClick={() => void pageBoardExport.current?.("png")} className="inline-flex shrink-0 items-center justify-center gap-1 rounded px-1.5 py-1 hover:bg-hover hover:text-fg max-sm:h-11 max-sm:min-w-11 max-sm:rounded-lg"><IconDownload className="h-4 w-4" /><span className="max-sm:hidden">PNG</span></button>
            <button type="button" aria-label="Download as SVG" onClick={() => void pageBoardExport.current?.("svg")} className="inline-flex shrink-0 items-center justify-center gap-1 rounded px-1.5 py-1 hover:bg-hover hover:text-fg max-sm:hidden"><IconDownload className="h-4 w-4" />SVG</button>
          </>
        )}
        <ShareButton kind="doc" targetId={id} />
        {docsPlus && <DocCommentsButton docId={id} open={commentsOpen} onToggle={() => setCommentsOpen((o) => !o)} />}
        <DocHistoryButton onOpen={openHistory} />
        <button aria-label="Save as template" title="Save as template" className="inline-flex items-center justify-center gap-1 rounded px-1.5 py-1 hover:bg-hover hover:text-fg max-sm:h-11 max-sm:min-w-11 max-sm:rounded-lg"
          onClick={async () => {
            // Save pending edits first: the template copies the stored doc.
            if (state === "unsaved") { clearTimeout(timer.current); await save(); }
            try { await api.post("/templates", { kind: "doc", fromDocId: id, name: title.trim() || undefined }); toast.success("Saved as a doc template"); } catch (err) { showError(err as Error); }
          }}>
          <IconTemplate className="h-4 w-4 max-sm:h-5 max-sm:w-5" /><span className="max-2xl:hidden">Save as template</span>
        </button>
        <button aria-label="Delete doc" className="inline-flex shrink-0 items-center justify-center rounded p-1 hover:text-bad max-sm:h-11 max-sm:w-11 max-sm:rounded-lg" onClick={async () => { if (!(await confirm({ ...deleteDocConfirm(tree.data?.tree, id, title), confirmLabel: "Delete doc" }))) return; await api.del(`/docs/${id}`); void qc.invalidateQueries({ queryKey: ["doc-tree"] }); navigate("/app/docs"); }}><IconTrash className="h-4 w-4 max-sm:h-5 max-sm:w-5" /></button>
      </div>
      <DocBreadcrumbs docId={id} title={title} />
      <h1 className="sr-only">{title || "Untitled doc"}</h1>
      <input aria-label="Doc title" value={title}
        onChange={(ev) => { setTitle(ev.target.value); if (session) meta(session.ydoc).set("title", ev.target.value); }}
        onBlur={() => void saveTitle()}
        className={cn("w-full bg-transparent font-semibold tracking-tight outline-none", isBoard ? "text-[20px]" : "text-[26px]")} placeholder="Untitled" />
      {!isBoard && <MeetingNotesBacklink docId={doc.id} />}
      {!isBoard && mode === "doc" && <CatchupCard key={`catchup-${doc.id}`} type="doc" id={doc.id} className="mx-0" />}
      {!isBoard && doc.links.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {doc.links.map((l) => (
            <Link key={`${l.type}:${l.id}`} to={l.type === "task" ? `/app/tasks?view=list&task=${l.id}` : l.type === "contact" ? `/app/contacts/${l.id}` : l.type === "project" ? `/app/tasks?project=${l.id}` : "#"}
              className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[12px] text-muted hover:text-fg">
              {l.type === "task" ? <IconTasks className="h-3 w-3" /> : l.type === "contact" ? <IconUser className="h-3 w-3" /> : <IconDocs className="h-3 w-3" />}Linked {l.type}
            </Link>
          ))}
        </div>
      )}
      {visual && !isBoard && (
        <div role="group" aria-label="View" className="mt-3 inline-flex rounded-lg border border-line p-0.5 sm:hidden">
          {(["doc", "mindmap"] as DocMode[]).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setParam("mode", m === "doc" ? null : "mindmap")}
              className={cn("min-h-10 rounded-md px-3 text-[14px]", mode === m ? "bg-brand-soft font-medium text-brand-hover" : "text-muted")}>{m === "doc" ? "Doc" : "Mind map"}</button>
          ))}
        </div>
      )}
      {e && !isBoard && mode === "doc" && (
        <div className="sticky top-0 z-10 mt-4 flex flex-wrap gap-0.5 rounded-lg border border-line bg-surface/95 p-1 shadow-card backdrop-blur max-sm:-mx-1 max-sm:mt-3 max-sm:flex-nowrap max-sm:justify-between max-sm:gap-0 max-sm:rounded-xl max-sm:p-0.5" role="toolbar" aria-label="Formatting" data-testid="doc-toolbar">
          <ToolButton label="Bold" active={e.isActive("bold")} on={() => e.chain().focus().toggleBold().run()}><IconBold /></ToolButton>
          <ToolButton label="Italic" active={e.isActive("italic")} on={() => e.chain().focus().toggleItalic().run()}><IconItalic /></ToolButton>
          <ToolButton label="Heading" active={e.isActive("heading", { level: 2 })} on={() => e.chain().focus().toggleHeading({ level: 2 }).run()}><IconHeading2 /></ToolButton>
          <ToolButton label="Bulleted list" active={e.isActive("bulletList")} on={() => e.chain().focus().toggleBulletList().run()}><IconList /></ToolButton>
          <ToolButton label="Numbered list" active={e.isActive("orderedList")} on={() => e.chain().focus().toggleOrderedList().run()}><IconListOrdered /></ToolButton>
          <ToolButton label="Quote" active={e.isActive("blockquote")} on={() => e.chain().focus().toggleBlockquote().run()}><IconQuote /></ToolButton>
          {docsPlus && <SpellButton compact getText={() => e.getText({ blockSeparator: "\n" })} onFix={(f) => fixInEditor(e, f)} />}
          <ToolButton label="Link a page or task" active={picker} on={() => setPicker((p) => !p)}><IconLink /></ToolButton>
          <PageLinkPicker editor={e} open={picker} onClose={() => setPicker(false)} selfId={id} />
        </div>
      )}
      {mode === "mindmap" && editor && (
        <div className="mt-4 flex h-[calc(100dvh-220px)] min-h-[420px] flex-col">
          <Suspense fallback={<Skeleton className="h-full" />}>
            <MindMapView editor={editor} title={title} readOnly={!editor.isEditable} onRenameTitle={(t) => { setTitle(t); if (session) meta(session.ydoc).set("title", t); void (async () => { try { saved((await api.patch<{ doc: Doc }>(`/docs/${id}`, { title: t })).doc); } catch (err) { showError(err as Error); } })(); }} />
          </Suspense>
        </div>
      )}
      <div className={cn(isBoard ? "mt-2 h-[calc(100dvh-170px)] min-h-[420px] max-sm:h-[calc(100dvh-150px)]" : "mt-4", mode === "mindmap" && "hidden")}><EditorContent editor={editor} className={isBoard ? "h-full" : undefined} /></div>
      {presenting && editor && (
        <Suspense fallback={null}>
          <PresentOverlay docId={id} doc={editor.getJSON() as PMNode} title={title} start={Number(sp.get("slide")) || 0} onClose={() => setParam("present", null)} />
        </Suspense>
      )}
      <SlashMenu editor={editor} onLinkPicker={openPicker} onImage={openImageDialog} />
      {docsPlus && <SpellAttrs editor={editor} />}
      {docsPlus && <DocCommentsPanel docId={id} open={commentsOpen} onClose={() => setCommentsOpen(false)} />}
      <TableMenu editor={editor} />
      <ImageToolbar editor={editor} />
      <ImageInsertDialog editor={editor} open={imageDialog} onClose={() => setImageDialog(false)} upload={uploadImage} />
      {!isBoard && <div className="pb-24"><LinkedFrom docId={id} /></div>}
      <DocHistoryPanel docId={id} open={history} onClose={() => setHistory(false)} currentText={editor?.getText({ blockSeparator: "\n" }) ?? doc.text}
        beforeChange={async () => { if (state === "unsaved") { clearTimeout(timer.current); await save(); } }} onRestored={(d) => onReplaced(d as Doc)} />
    </div>
  );
}
