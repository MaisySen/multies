import { NoDocsArt } from "@/web/components/illustrations";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { CatchupCard } from "@/web/components/catchup-card"; // R31
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Transaction } from "@tiptap/pm/state";
import { IconArrowLeft, IconBold, IconDocs, IconHeading2, IconItalic, IconLink, IconList, IconListOrdered, IconPlus, IconQuote, IconTasks, IconTemplate, IconTrash, IconUser } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { useDialogs } from "@/web/components/ui/confirm";
import { Input } from "@/web/components/ui/input";
import { EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { useMe } from "@/web/lib/queries";
import { colourFor, meta, type CollabSession } from "./doc-collab";
import { docExtensions, liveDomEvents, liveKeyDown, useCollabDoc, useCollabSession } from "./collab-editor";
import { tone } from "@/web/components/app-bits";
import { MeetingNotesBacklink } from "./meeting-notes";
import { ShareButton } from "./share-sheet"; // R26 (MB-87)
import { SlashMenu } from "./slash-menu"; // R31: "/" menu for every block
import { uploadDocImage } from "@/web/lib/docs-blocks"; // R32: table, image and callout blocks
import { ImageInsertDialog, ImageToolbar, TableMenu } from "./doc-block-menus";
import { DocBreadcrumbs, DocTreeSidebar, LinkedFrom, PageLinkPicker, deleteDocConfirm, useBracketTrigger, useDocTree } from "./doc-tree";

interface DocSummary { id: string; title: string; excerpt: string; updatedAt: string; projectId: string | null }
interface Doc extends DocSummary { content: Record<string, unknown>; text: string; version: number; links: { type: string; id: string }[] }

export function DocsPage() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const docs = useQuery({ queryKey: ["docs", q], queryFn: async () => (await api.get<{ docs: DocSummary[] }>(`/docs${q ? `?q=${encodeURIComponent(q)}` : ""}`)).docs });
  const create = async () => {
    try { const r = await api.post<{ doc: Doc }>("/docs", { title: "Untitled", text: "" }); navigate(`/app/docs/${r.doc.id}`); } catch (e) { showError(e as Error); }
  };
  // R30: /app/docs?new=1 (from the command menu) starts a new doc once, then opens it.
  const [params] = useSearchParams();
  const started = useRef(false);
  useEffect(() => {
    if (params.get("new") !== "1" || started.current) return;
    started.current = true;
    void create();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
  return (
    <div className="flex gap-6">
      <DocTreeSidebar />
      <div className="min-w-0 flex-1">
      <PageHeader title="Docs" description="Briefs, meeting notes and plans, linked to tasks, projects, threads and contacts. Agents can read and add to them too." actions={<Button onClick={create}><IconPlus className="h-4 w-4" />New doc</Button>} />
      <Input aria-label="Search docs" placeholder="Search docs" value={q} onChange={(e) => setQ(e.target.value)} className="mb-4 max-w-sm" />
      {docs.isPending ? <Skeleton className="h-40" /> : !docs.data?.length ? (
        <EmptyState icon={<IconDocs />} art={q ? undefined : <NoDocsArt />} title={q ? "No docs match" : "No docs yet"} body="Write a brief or notes and link it to the work it belongs to." action={!q && <Button onClick={create}>New doc</Button>} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="doc-list">
          {docs.data.map((d) => (
            <li key={d.id}><Link to={`/app/docs/${d.id}`} className="block h-full rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong">
              <div className="flex items-center gap-2 text-[14px] font-medium"><IconDocs className="h-4 w-4 text-muted" />{d.title}</div>
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
    className={cn("inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-muted transition-colors duration-150 ease-out hover:bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:h-10 max-sm:w-10 [&_svg]:h-4 [&_svg]:w-4", active && "bg-brand-soft text-brand-hover hover:bg-brand-soft hover:text-brand-hover")}>{children}</button>;
}

export function DocPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["doc", id], queryFn: async () => (await api.get<{ doc: Doc }>(`/docs/${id}`)).doc, refetchOnWindowFocus: false });
  // Co-editing when the room answers; otherwise the single person editor.
  const collab = useCollabSession(id);

  const body = q.isPending || !collab ? <div className="mx-auto max-w-3xl space-y-3"><Skeleton className="h-9 w-1/2" /><Skeleton className="h-64" /></div>
    : q.error ? <EmptyState icon={<IconDocs />} title="Doc not found" body="It may have been deleted." action={<Button onClick={() => navigate("/app/docs")}>All docs</Button>} />
    : <DocEditor key={`${id}:${collab.session ? "live" : "solo"}`} doc={q.data} session={collab.session} />;
  // R24.5: the page tree beside the doc.
  return <div className="flex gap-6"><DocTreeSidebar currentId={id} /><div className="min-w-0 flex-1">{body}</div></div>;
}

const EDITOR_PROPS = { attributes: { class: "mm-prose min-h-[50vh] outline-none", "aria-label": "Doc body", role: "textbox", "aria-multiline": "true" } };

const LIVE_EDITOR_PROPS = { ...EDITOR_PROPS, handleKeyDown: liveKeyDown, handleDOMEvents: liveDomEvents };

function DocEditor({ doc, session }: { doc: Doc; session: CollabSession | null }) {
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
  const extensions = useMemo(() => docExtensions(session, { upload: (f: File) => uploadDocImage(id, f), onError: showError }), [session, id]);
  const editor = useEditor({
    extensions,
    // No content key at all in a live session: the room is the content, and an option
    // that differs from the editor's own makes Tiptap reconfigure on every render.
    ...(session ? {} : { content: doc.content as never }),
    editorProps: session ? LIVE_EDITOR_PROPS : EDITOR_PROPS,
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
  const status = state === "saving" ? "Saving" : state === "unsaved" ? "Unsaved changes" : state === "conflict" ? "Changed elsewhere. Reload to see the latest." : "Saved";
  return (
    <div className="mx-auto max-w-3xl">
      {dialogs}
      <div className="mb-3 flex items-center gap-2 text-[12.5px] text-subtle">
        <Link to="/app/docs" className="inline-flex items-center gap-1 hover:text-fg"><IconArrowLeft className="h-3.5 w-3.5" />Docs</Link>
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
        <ShareButton kind="doc" targetId={id} />
        <button aria-label="Save as template" title="Save as template" className="inline-flex items-center justify-center gap-1 rounded px-1.5 py-1 hover:bg-hover hover:text-fg max-sm:h-10 max-sm:min-w-10"
          onClick={async () => {
            // Save pending edits first: the template copies the stored doc.
            if (state === "unsaved") { clearTimeout(timer.current); await save(); }
            try { await api.post("/templates", { kind: "doc", fromDocId: id, name: title.trim() || undefined }); toast.success("Saved as a doc template"); } catch (err) { showError(err as Error); }
          }}>
          <IconTemplate className="h-4 w-4" /><span className="max-sm:hidden">Save as template</span>
        </button>
        <button aria-label="Delete doc" className="inline-flex shrink-0 items-center justify-center rounded p-1 hover:text-bad max-sm:h-10 max-sm:w-10" onClick={async () => { if (!(await confirm({ ...deleteDocConfirm(tree.data?.tree, id, title), confirmLabel: "Delete doc" }))) return; await api.del(`/docs/${id}`); void qc.invalidateQueries({ queryKey: ["doc-tree"] }); navigate("/app/docs"); }}><IconTrash className="h-4 w-4" /></button>
      </div>
      <DocBreadcrumbs docId={id} title={title} />
      <h1 className="sr-only">{title || "Untitled doc"}</h1>
      <input aria-label="Doc title" value={title}
        onChange={(ev) => { setTitle(ev.target.value); if (session) meta(session.ydoc).set("title", ev.target.value); }}
        onBlur={() => void saveTitle()}
        className="w-full bg-transparent text-[26px] font-semibold tracking-tight outline-none" placeholder="Untitled" />
      <MeetingNotesBacklink docId={doc.id} />
      <CatchupCard key={`catchup-${doc.id}`} type="doc" id={doc.id} className="mx-0" />
      {doc.links.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {doc.links.map((l) => (
            <Link key={`${l.type}:${l.id}`} to={l.type === "task" ? `/app/tasks?view=list&task=${l.id}` : l.type === "contact" ? `/app/contacts/${l.id}` : l.type === "project" ? `/app/tasks?project=${l.id}` : "#"}
              className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[12px] text-muted hover:text-fg">
              {l.type === "task" ? <IconTasks className="h-3 w-3" /> : l.type === "contact" ? <IconUser className="h-3 w-3" /> : <IconDocs className="h-3 w-3" />}Linked {l.type}
            </Link>
          ))}
        </div>
      )}
      {e && (
        <div className="sticky top-0 z-10 mt-4 flex flex-wrap gap-0.5 rounded-lg border border-line bg-surface/95 p-1 shadow-card backdrop-blur max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:overscroll-x-contain max-sm:[scrollbar-width:none]" role="toolbar" aria-label="Formatting">
          <ToolButton label="Bold" active={e.isActive("bold")} on={() => e.chain().focus().toggleBold().run()}><IconBold /></ToolButton>
          <ToolButton label="Italic" active={e.isActive("italic")} on={() => e.chain().focus().toggleItalic().run()}><IconItalic /></ToolButton>
          <ToolButton label="Heading" active={e.isActive("heading", { level: 2 })} on={() => e.chain().focus().toggleHeading({ level: 2 }).run()}><IconHeading2 /></ToolButton>
          <ToolButton label="Bulleted list" active={e.isActive("bulletList")} on={() => e.chain().focus().toggleBulletList().run()}><IconList /></ToolButton>
          <ToolButton label="Numbered list" active={e.isActive("orderedList")} on={() => e.chain().focus().toggleOrderedList().run()}><IconListOrdered /></ToolButton>
          <ToolButton label="Quote" active={e.isActive("blockquote")} on={() => e.chain().focus().toggleBlockquote().run()}><IconQuote /></ToolButton>
          <ToolButton label="Link a page or task" active={picker} on={() => setPicker((p) => !p)}><IconLink /></ToolButton>
          <PageLinkPicker editor={e} open={picker} onClose={() => setPicker(false)} selfId={id} />
        </div>
      )}
      <div className="mt-4"><EditorContent editor={editor} /></div>
      <SlashMenu editor={editor} onLinkPicker={openPicker} onImage={openImageDialog} />
      <TableMenu editor={editor} />
      <ImageToolbar editor={editor} />
      <ImageInsertDialog editor={editor} open={imageDialog} onClose={() => setImageDialog(false)} upload={uploadImage} />
      <div className="pb-24"><LinkedFrom docId={id} /></div>
    </div>
  );
}
