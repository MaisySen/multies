import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { ArrowLeft, Bold, CheckSquare, FileText, Heading2, Italic, List, ListOrdered, Plus, Quote, Trash2, User } from "lucide-react";
import { api, ApiError } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Input } from "@/web/components/ui/input";
import { EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";

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
              <p className="mt-2 line-clamp-3 text-[13px] leading-relaxed text-muted">{d.excerpt || "Empty"}</p>
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
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["doc", id], queryFn: async () => (await api.get<{ doc: Doc }>(`/docs/${id}`)).doc, refetchOnWindowFocus: false });
  const [title, setTitle] = useState("");
  const [state, setState] = useState<"saved" | "saving" | "unsaved" | "conflict">("saved");
  const version = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const editor = useEditor({
    extensions: [StarterKit],
    content: "",
    editorProps: { attributes: { class: "mm-prose min-h-[50vh] outline-none", "aria-label": "Doc body", role: "textbox", "aria-multiline": "true" } },
    onUpdate: () => schedule(),
    immediatelyRender: true,
  });
  useEffect(() => {
    if (q.data && editor && version.current === 0) {
      editor.commands.setContent(q.data.content as never, { emitUpdate: false });
      setTitle(q.data.title);
      version.current = q.data.version;
    }
  }, [q.data, editor]);

  const save = async (patch: Record<string, unknown> = {}) => {
    if (!editor) return;
    setState("saving");
    try {
      const r = await api.patch<{ doc: Doc }>(`/docs/${id}`, { content: editor.getJSON(), title, version: version.current, ...patch });
      version.current = r.doc.version;
      setState("saved");
      void qc.invalidateQueries({ queryKey: ["docs"] });
    } catch (e) {
      if (e instanceof ApiError && e.code === "version_conflict") setState("conflict"); else { setState("unsaved"); showError(e as Error); }
    }
  };
  const schedule = () => { setState("unsaved"); clearTimeout(timer.current); timer.current = setTimeout(() => void save(), 900); };
  useEffect(() => () => clearTimeout(timer.current), []);

  if (q.isPending) return <div className="mx-auto max-w-3xl space-y-3"><Skeleton className="h-9 w-1/2" /><Skeleton className="h-64" /></div>;
  if (q.error) return <EmptyState icon={<FileText />} title="Doc not found" body="It may have been deleted." action={<Button onClick={() => navigate("/app/docs")}>All docs</Button>} />;
  const e = editor;
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-3 flex items-center gap-2 text-[12.5px] text-subtle">
        <Link to="/app/docs" className="inline-flex items-center gap-1 hover:text-fg"><ArrowLeft className="h-3.5 w-3.5" />Docs</Link>
        <span className="ml-auto" role="status">{state === "saving" ? "Saving" : state === "unsaved" ? "Unsaved changes" : state === "conflict" ? "Changed elsewhere. Reload to see the latest." : "Saved"}</span>
        <button aria-label="Delete doc" className="rounded p-1 hover:text-bad" onClick={async () => { if (!window.confirm("Delete this doc?")) return; await api.del(`/docs/${id}`); navigate("/app/docs"); }}><Trash2 className="h-4 w-4" /></button>
      </div>
      <input aria-label="Doc title" value={title} onChange={(ev) => setTitle(ev.target.value)} onBlur={() => title !== q.data.title && void save({ title })}
        className="w-full bg-transparent text-[26px] font-semibold tracking-tight outline-none" placeholder="Untitled" />
      {q.data.links.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {q.data.links.map((l) => (
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
