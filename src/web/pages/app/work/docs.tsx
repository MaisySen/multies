import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Link, useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { ArrowLeft, Bold, CheckSquare, FileText, Heading2, Italic, LayoutTemplate, List, ListOrdered, Plus, Quote, Trash2, User } from "lucide-react";
import { api, ApiError } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Input } from "@/web/components/ui/input";
import { EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { useMe } from "@/web/lib/queries";
import { colourFor, connectCollab, FIELD, hashText, isLeader, meta, peersOf, seedIfEmpty, type CollabSession, type Peer } from "./doc-collab";
import { tone } from "@/web/components/app-bits";
import { MeetingNotesBacklink } from "./meeting-notes";

interface DocSummary { id: string; title: string; excerpt: string; updatedAt: string; projectId: string | null }
interface Doc extends DocSummary { content: Record<string, unknown>; text: string; version: number; links: { type: string; id: string }[] }

export function DocsPage() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const docs = useQuery({ queryKey: ["docs", q], queryFn: async () => (await api.get<{ docs: DocSummary[] }>(`/docs${q ? `?q=${encodeURIComponent(q)}` : ""}`)).docs });
  const create = async () => {
    try { const r = await api.post<{ doc: Doc }>("/docs", { title: "Untitled", text: "" }); navigate(`/app/docs/${r.doc.id}`); } catch (e) { showError(e as Error); }
  };
  return (
    <div>
      <PageHeader title="Docs" description="Briefs, meeting notes and plans, linked to tasks, projects, threads and contacts. Agents can read and add to them too." actions={<Button onClick={create}><Plus className="h-4 w-4" />New doc</Button>} />
      <Input aria-label="Search docs" placeholder="Search docs" value={q} onChange={(e) => setQ(e.target.value)} className="mb-4 max-w-sm" />
      {docs.isPending ? <Skeleton className="h-40" /> : !docs.data?.length ? (
        <EmptyState icon={<FileText />} title={q ? "No docs match" : "No docs yet"} body="Write a brief or notes and link it to the work it belongs to." action={!q && <Button onClick={create}>New doc</Button>} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="doc-list">
          {docs.data.map((d) => (
            <li key={d.id}><Link to={`/app/docs/${d.id}`} className="block h-full rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong">
              <div className="flex items-center gap-2 text-[14px] font-medium"><FileText className="h-4 w-4 text-muted" />{d.title}</div>
              <p className="mt-2 line-clamp-3 whitespace-pre-line text-[13px] leading-relaxed text-muted">{d.excerpt || "Empty"}</p>
              <p className="mt-3 text-[12px] text-subtle">Edited {timeAgo(d.updatedAt)}</p>
            </Link></li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ToolButton({ on, label, active, children }: { on: () => void; label: string; active?: boolean; children: React.ReactNode }) {
  return <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={on} aria-label={label} aria-pressed={active} title={label}
    className={cn("rounded-md p-1.5 text-muted hover:bg-elevated hover:text-fg [&_svg]:h-4 [&_svg]:w-4", active && "bg-elevated text-fg")}>{children}</button>;
}

export function DocPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["doc", id], queryFn: async () => (await api.get<{ doc: Doc }>(`/docs/${id}`)).doc, refetchOnWindowFocus: false });
  // Co-editing when the room answers; otherwise the single person editor.
  const [collab, setCollab] = useState<{ id: string; session: CollabSession | null } | null>(null);
  useEffect(() => {
    let live = true;
    let opened: CollabSession | null = null;
    setCollab(null);
    void connectCollab(id).then((session) => {
      opened = session;
      if (live) setCollab({ id, session });
      else if (session) { session.provider.destroy(); session.ydoc.destroy(); }
    });
    return () => { live = false; if (opened) { opened.provider.destroy(); opened.ydoc.destroy(); } };
  }, [id]);

  if (q.isPending || !collab || collab.id !== id) return <div className="mx-auto max-w-3xl space-y-3"><Skeleton className="h-9 w-1/2" /><Skeleton className="h-64" /></div>;
  if (q.error) return <EmptyState icon={<FileText />} title="Doc not found" body="It may have been deleted." action={<Button onClick={() => navigate("/app/docs")}>All docs</Button>} />;
  return <DocEditor key={`${id}:${collab.session ? "live" : "solo"}`} doc={q.data} session={collab.session} />;
}

/** Another person's caret with their name above it (styled in code, so no stylesheet is needed). */
function renderCaret(user: Record<string, unknown>) {
  const colour = typeof user.color === "string" ? user.color : "#e8590c";
  const caret = document.createElement("span");
  caret.className = "collaboration-carets__caret";
  Object.assign(caret.style, { position: "relative", marginLeft: "-1px", marginRight: "-1px", borderLeft: `2px solid ${colour}`, wordBreak: "normal", pointerEvents: "none" });
  const label = document.createElement("span");
  label.className = "collaboration-carets__label";
  Object.assign(label.style, {
    position: "absolute", top: "-1.45em", left: "-2px", padding: "1px 6px", borderRadius: "4px 4px 4px 0", background: colour, color: "#fff",
    fontSize: "11px", fontWeight: "600", lineHeight: "1.4", whiteSpace: "nowrap", userSelect: "none",
  });
  label.textContent = typeof user.name === "string" ? user.name : "Someone";
  caret.append(label);
  return caret;
}

const EDITOR_PROPS = { attributes: { class: "mm-prose min-h-[50vh] outline-none", "aria-label": "Doc body", role: "textbox", "aria-multiline": "true" } };

/**
 * A remote edit that lands in the same instant as a click can leave the editor's own
 * selection behind the caret the browser shows, and the next keystroke then goes to the
 * old place. Before each key and after each click, take the browser's caret if they differ.
 */
function syncSelectionFromDom(view: EditorView) {
  const sel = view.dom.ownerDocument.getSelection();
  if (!sel?.anchorNode || !sel.focusNode || !view.dom.contains(sel.anchorNode) || !(view.state.selection instanceof TextSelection)) return;
  try {
    const anchor = view.posAtDOM(sel.anchorNode, sel.anchorOffset);
    const head = view.posAtDOM(sel.focusNode, sel.focusOffset);
    const cur = view.state.selection;
    if (cur.anchor !== anchor || cur.head !== head) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head)));
  } catch {
    // A caret the editor cannot map (inside a widget) stays as it is.
  }
}

const LIVE_EDITOR_PROPS = {
  ...EDITOR_PROPS,
  handleKeyDown: (view: EditorView, event: KeyboardEvent) => { if (!event.isComposing) syncSelectionFromDom(view); return false; },
  handleDOMEvents: { mouseup: (view: EditorView) => { setTimeout(() => { if (!view.isDestroyed) syncSelectionFromDom(view); }, 0); return false; } },
};

type SaveState = "saved" | "saving" | "unsaved" | "conflict";

function DocEditor({ doc, session }: { doc: Doc; session: CollabSession | null }) {
  const id = doc.id;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useMe();
  const [title, setTitle] = useState(doc.title);
  const [state, setState] = useState<SaveState>("saved");
  const [peers, setPeers] = useState<Peer[]>([]);
  const version = useRef(doc.version);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The editor can report an update while it is being created (the room's content
  // arriving), before schedule() below exists, so updates go through a ref.
  const onUpdate = useRef(() => {});
  const userName = me.data?.user.name || me.data?.user.email || "Someone";
  const userColour = colourFor(me.data?.user.id ?? userName);
  // Stable options: a new extensions array or editorProps object on a render makes Tiptap
  // reconfigure the view, which redraws the shared document and drops the cursor.
  const extensions = useMemo(() => (session
    ? [
        StarterKit.configure({ undoRedo: false }), TaskList, TaskItem.configure({ nested: true }),
        Collaboration.configure({ document: session.ydoc, field: FIELD }),
        CollaborationCaret.configure({ provider: session.provider, user: { name: "Someone", color: "#e8590c" }, render: renderCaret }),
      ]
    : [StarterKit, TaskList, TaskItem.configure({ nested: true })]), [session]);
  const editor = useEditor({
    extensions,
    // No content key at all in a live session: the room is the content, and an option
    // that differs from the editor's own makes Tiptap reconfigure on every render.
    ...(session ? {} : { content: doc.content as never }),
    editorProps: session ? LIVE_EDITOR_PROPS : EDITOR_PROPS,
    onUpdate: () => onUpdate.current(),
    immediatelyRender: true,
  });

  const saved = (d: Doc) => {
    version.current = d.version;
    if (session) session.ydoc.transact(() => { const m = meta(session.ydoc); m.set("version", d.version); m.set("rowText", hashText(d.text)); });
    setState("saved");
    void qc.invalidateQueries({ queryKey: ["docs"] });
  };

  /** Leader only: brings the room in line with the doc row when someone changed it elsewhere. */
  const reconcile = async (): Promise<"same" | "adopted" | "loaded"> => {
    if (!session || !editor) return "same";
    const row = (await api.get<{ doc: Doc }>(`/docs/${id}`)).doc;
    const m = meta(session.ydoc);
    if (row.version === m.get("version")) return "same";
    if (hashText(row.text) === m.get("rowText")) {
      session.ydoc.transact(() => { m.set("version", row.version); if (row.title !== m.get("title")) m.set("title", row.title); });
      version.current = row.version;
      return "adopted";
    }
    editor.commands.setContent(row.content as never, { emitUpdate: false });
    session.ydoc.transact(() => {
      m.set("version", row.version); m.set("rowText", hashText(row.text));
      m.set("json", hashText(JSON.stringify(editor.getJSON()))); m.set("title", row.title);
    });
    version.current = row.version;
    setState("saved");
    return "loaded";
  };

  const save = async (patch: Record<string, unknown> = {}, retried = false): Promise<void> => {
    if (!editor) return;
    if (session) {
      if (!isLeader(session)) { setState("saved"); return; }
      const m = meta(session.ydoc);
      const json = editor.getJSON();
      const h = hashText(JSON.stringify(json));
      if (h === m.get("json") && !patch.title) { setState("saved"); return; }
      setState("saving");
      try {
        const r = await api.patch<{ doc: Doc }>(`/docs/${id}`, { content: json, version: (m.get("version") as number | undefined) ?? version.current, ...patch });
        m.set("json", h);
        saved(r.doc);
      } catch (e) {
        if (e instanceof ApiError && e.code === "version_conflict" && !retried) {
          // Someone else wrote the row: keep our text if only the version moved, else load theirs.
          if ((await reconcile()) === "adopted") return save(patch, true);
          return;
        }
        setState("unsaved");
        showError(e as Error);
      }
      return;
    }
    setState("saving");
    try {
      const r = await api.patch<{ doc: Doc }>(`/docs/${id}`, { content: editor.getJSON(), title, version: version.current, ...patch });
      saved(r.doc);
    } catch (e) {
      if (e instanceof ApiError && e.code === "version_conflict") setState("conflict"); else { setState("unsaved"); showError(e as Error); }
    }
  };
  const schedule = () => {
    if (session && !isLeader(session)) return;
    setState("unsaved"); clearTimeout(timer.current); timer.current = setTimeout(() => void save(), 900);
  };
  onUpdate.current = schedule;
  useEffect(() => () => clearTimeout(timer.current), []);

  const saveTitle = async () => {
    if (!session) { if (title !== doc.title) void save({ title }); return; }
    const m = meta(session.ydoc);
    if (title === doc.title && title === (m.get("title") ?? doc.title)) return;
    try { saved((await api.patch<{ doc: Doc }>(`/docs/${id}`, { title })).doc); } catch (e) { showError(e as Error); }
  };

  // Live session: seed an empty room, follow presence and the shared title, and keep
  // the row in step while this client is the leader.
  useEffect(() => {
    if (!session || !editor) return;
    if (seedIfEmpty(session.ydoc, editor.schema, doc)) meta(session.ydoc).set("json", hashText(JSON.stringify(editor.getJSON())));
    else if (isLeader(session)) void reconcile().catch(() => undefined);
    const m = meta(session.ydoc);
    const onMeta = () => { const t = m.get("title"); if (typeof t === "string") setTitle(t); };
    m.observe(onMeta);
    onMeta();
    const onPresence = () => setPeers(peersOf(session));
    session.provider.awareness.on("change", onPresence);
    onPresence();
    const poll = setInterval(() => {
      if (document.visibilityState === "visible" && isLeader(session)) void reconcile().catch(() => undefined);
    }, 15_000);
    return () => { m.unobserve(onMeta); session.provider.awareness.off("change", onPresence); clearInterval(poll); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, editor]);
  useEffect(() => {
    if (session && editor) editor.commands.updateUser({ name: userName, color: userColour });
  }, [session, editor, userName, userColour]);

  const e = editor;
  const status = state === "saving" ? "Saving" : state === "unsaved" ? "Unsaved changes" : state === "conflict" ? "Changed elsewhere. Reload to see the latest." : "Saved";
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-3 flex items-center gap-2 text-[12.5px] text-subtle">
        <Link to="/app/docs" className="inline-flex items-center gap-1 hover:text-fg"><ArrowLeft className="h-3.5 w-3.5" />Docs</Link>
        {session && (
          <div className="ml-auto flex items-center gap-1.5" data-testid="collab-presence" aria-label={peers.length ? `Also here: ${peers.map((p) => p.name).join(", ")}` : "Only you are here"}>
            <span className="inline-flex items-center gap-1 text-[12px]"><span className="h-1.5 w-1.5 rounded-full bg-good" aria-hidden />Live</span>
            {peers.map((p) => (
              <span key={p.clientId} data-testid="collab-peer" title={p.name} className="inline-flex max-w-[10rem] items-center gap-1 whitespace-nowrap rounded-full border border-line px-2 py-0.5 text-[12px] text-fg">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: tone(p.color) }} aria-hidden /><span className="truncate">{p.name.split(" ")[0]}</span>
              </span>
            ))}
          </div>
        )}
        <span className={cn(!session && "ml-auto")} role="status">{status}</span>
        <button aria-label="Save as template" title="Save as template" className="inline-flex items-center gap-1 rounded px-1.5 py-1 hover:bg-hover hover:text-fg"
          onClick={async () => {
            // Save pending edits first: the template copies the stored doc.
            if (state === "unsaved") { clearTimeout(timer.current); await save(); }
            try { await api.post("/templates", { kind: "doc", fromDocId: id, name: title.trim() || undefined }); toast.success("Saved as a doc template"); } catch (err) { showError(err as Error); }
          }}>
          <LayoutTemplate className="h-4 w-4" /><span className="max-sm:hidden">Save as template</span>
        </button>
        <button aria-label="Delete doc" className="rounded p-1 hover:text-bad" onClick={async () => { if (!window.confirm("Delete this doc?")) return; await api.del(`/docs/${id}`); navigate("/app/docs"); }}><Trash2 className="h-4 w-4" /></button>
      </div>
      <h1 className="sr-only">{title || "Untitled doc"}</h1>
      <input aria-label="Doc title" value={title}
        onChange={(ev) => { setTitle(ev.target.value); if (session) meta(session.ydoc).set("title", ev.target.value); }}
        onBlur={() => void saveTitle()}
        className="w-full bg-transparent text-[26px] font-semibold tracking-tight outline-none" placeholder="Untitled" />
      <MeetingNotesBacklink docId={doc.id} />
      {doc.links.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {doc.links.map((l) => (
            <Link key={`${l.type}:${l.id}`} to={l.type === "task" ? `/app/tasks?view=list&task=${l.id}` : l.type === "contact" ? `/app/contacts/${l.id}` : l.type === "project" ? `/app/tasks?project=${l.id}` : "#"}
              className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[12px] text-muted hover:text-fg">
              {l.type === "task" ? <CheckSquare className="h-3 w-3" /> : l.type === "contact" ? <User className="h-3 w-3" /> : <FileText className="h-3 w-3" />}Linked {l.type}
            </Link>
          ))}
        </div>
      )}
      {e && (
        <div className="sticky top-0 z-10 mt-4 flex flex-wrap gap-0.5 rounded-lg border border-line bg-surface/95 p-1 backdrop-blur" role="toolbar" aria-label="Formatting">
          <ToolButton label="Bold" active={e.isActive("bold")} on={() => e.chain().focus().toggleBold().run()}><Bold /></ToolButton>
          <ToolButton label="Italic" active={e.isActive("italic")} on={() => e.chain().focus().toggleItalic().run()}><Italic /></ToolButton>
          <ToolButton label="Heading" active={e.isActive("heading", { level: 2 })} on={() => e.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 /></ToolButton>
          <ToolButton label="Bulleted list" active={e.isActive("bulletList")} on={() => e.chain().focus().toggleBulletList().run()}><List /></ToolButton>
          <ToolButton label="Numbered list" active={e.isActive("orderedList")} on={() => e.chain().focus().toggleOrderedList().run()}><ListOrdered /></ToolButton>
          <ToolButton label="Quote" active={e.isActive("blockquote")} on={() => e.chain().focus().toggleBlockquote().run()}><Quote /></ToolButton>
        </div>
      )}
      <div className="mt-4 pb-24"><EditorContent editor={editor} /></div>
    </div>
  );
}
