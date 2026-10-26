/** Templates: the starter gallery and saved project, task and doc templates, saved from an item or written from scratch. */
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconDocs, IconPlus, IconTemplate, IconTrash } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { useDialogs } from "@/web/components/ui/confirm";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { Card, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";

interface Template { id: string; kind: "project" | "task" | "doc"; name: string; description: string; category: string; builtin: boolean; taskCount: number }
interface Project { id: string; name: string }

const today = () => new Date().toISOString().slice(0, 10);

export function TemplatesPage() {
  const { confirm, dialogs } = useDialogs();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [using, setUsing] = useState<Template | null>(null);
  const [saving, setSaving] = useState(false);
  const [writing, setWriting] = useState(false);
  const q = useQuery({ queryKey: ["templates"], queryFn: async () => (await api.get<{ templates: Template[] }>("/templates")).templates });
  const projects = useQuery({ queryKey: ["projects"], queryFn: async () => (await api.get<{ projects: Project[] }>("/projects")).projects });
  const starters = (q.data ?? []).filter((t) => t.builtin);
  const mine = (q.data ?? []).filter((t) => !t.builtin);
  const remove = async (t: Template) => {
    if (!(await confirm({ title: `Delete the template ${t.name}?`, description: "Projects made from it stay as they are.", confirmLabel: "Delete template" }))) return;
    try { await api.del(`/templates/${t.id}`); await qc.invalidateQueries({ queryKey: ["templates"] }); } catch (e) { showError(e as Error); }
  };
  const card = (t: Template) => (
    <Card key={t.id} className="flex flex-col gap-2" data-testid="template-card">
      <div className="flex items-start justify-between gap-2">
        <div><h3 className="font-semibold">{t.name}</h3><p className="text-[12px] text-subtle">{t.category} · {t.kind === "project" ? `project, ${t.taskCount} tasks` : t.kind === "doc" ? "doc" : "task"}</p></div>
      {dialogs}
        {!t.builtin && <Button variant="ghost" size="icon" aria-label={`Delete ${t.name}`} onClick={() => void remove(t)}><IconTrash className="h-4 w-4" /></Button>}
      </div>
      {t.description && <p className="text-[13.5px] text-muted">{t.description}</p>}
      <div className="mt-auto pt-1"><Button size="sm" onClick={() => setUsing(t)}>Use template</Button></div>
    </Card>
  );
  return (
    <div>
      <PageHeader title="Templates" description="Start a project with its statuses, fields and tasks already in place. Due dates count from the start date you pick."
        actions={<div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" onClick={() => setSaving(true)}>Save a project as a template</Button><Button size="sm" onClick={() => setWriting(true)}><IconPlus className="h-4 w-4" />New template</Button></div>} />
      {q.isPending ? <Skeleton className="h-64" /> : (
        <>
          <h2 className="mb-3 text-[15px] font-semibold">Starter gallery</h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{starters.map(card)}</div>
          <h2 className="mb-3 mt-8 text-[15px] font-semibold">Your templates</h2>
          {mine.length ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{mine.map(card)}</div>
            : <EmptyState icon={<IconTemplate />} title="No saved templates yet" body="Write one from scratch with New template, save any project as a template, or save a task from its menu." />}
        </>
      )}
      <UseDialog t={using} projects={projects.data ?? []} onClose={() => setUsing(null)} onDone={(r) => {
        setUsing(null); void qc.invalidateQueries({ queryKey: ["projects"] });
        navigate(r.doc ? `/app/docs/${r.doc.id}` : r.project ? `/app/tasks?project=${r.project.id}&view=list` : `/app/tasks?task=${r.task!.id}`);
      }} />
      <NewDialog open={writing} onClose={() => setWriting(false)} onDone={() => { setWriting(false); void qc.invalidateQueries({ queryKey: ["templates"] }); }} />
      <SaveDialog open={saving} projects={projects.data ?? []} onClose={() => setSaving(false)} onDone={() => { setSaving(false); void qc.invalidateQueries({ queryKey: ["templates"] }); }} />
    </div>
  );
}

function UseDialog({ t, projects, onClose, onDone }: { t: Template | null; projects: Project[]; onClose: () => void; onDone: (r: { project?: { id: string }; task?: { id: string }; doc?: { id: string } }) => void }) {
  const [name, setName] = useState(""); const [start, setStart] = useState(today()); const [projectId, setProjectId] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (!t) return; setBusy(true);
    try { onDone(await api.post(`/templates/${t.id}/use`, { name: name || undefined, startDate: start || undefined, projectId: t.kind === "project" ? undefined : projectId || undefined })); setName(""); }
    catch (err) { showError(err as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open={!!t} onClose={onClose} title={t ? `Use "${t.name}"` : "Use template"}>
      <form onSubmit={submit} className="space-y-4 px-6 pb-6 pt-4">
        <Field label={t?.kind === "task" ? "Task title (optional)" : t?.kind === "doc" ? "Doc title (optional)" : "Project name (optional)"}>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder={t?.name} />}</Field>
        {t?.kind === "task" && <Field label="Project">{(p) => <Select {...p} value={projectId} onChange={(e) => setProjectId(e.target.value)} required><option value="">Choose a project</option>{projects.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>}
        {t?.kind === "doc" && <Field label="Project (optional)">{(p) => <Select {...p} value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">No project</option>{projects.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>}
        {t?.kind !== "doc" && <Field label="Start date">{(p) => <Input {...p} type="date" value={start} onChange={(e) => setStart(e.target.value)} />}</Field>}
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Create</Button></div>
      </form>
    </Dialog>
  );
}

function SaveDialog({ open, projects, onClose, onDone }: { open: boolean; projects: Project[]; onClose: () => void; onDone: () => void }) {
  const [projectId, setProjectId] = useState(""); const [name, setName] = useState(""); const [description, setDescription] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true);
    try { await api.post("/templates", { kind: "project", fromProjectId: projectId, name: name || undefined, description }); setName(""); setDescription(""); onDone(); }
    catch (err) { showError(err as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Save a project as a template" description="Statuses, custom fields, top level tasks with their subtasks and repeat rules are saved. Due dates are kept as days from the first one.">
      <form onSubmit={submit} className="space-y-4 px-6 pb-6 pt-4">
        <Field label="Project">{(p) => <Select {...p} value={projectId} onChange={(e) => setProjectId(e.target.value)} required><option value="">Choose a project</option>{projects.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
        <Field label="Template name (optional)">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Description (optional)">{(p) => <Input {...p} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Save template</Button></div>
      </form>
    </Dialog>
  );
}

const lines = (v: string) => v.split("\n").map((x) => x.trim()).filter(Boolean);

/** A template written from scratch: a task with subtasks, a doc, or a project with its tasks. */
function NewDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<Template["kind"]>("task");
  const [name, setName] = useState(""); const [description, setDescription] = useState("");
  const [title, setTitle] = useState(""); const [body, setBody] = useState(""); const [items, setItems] = useState(""); const [busy, setBusy] = useState(false);
  const reset = () => { setName(""); setDescription(""); setTitle(""); setBody(""); setItems(""); };
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true);
    const data = kind === "doc" ? { title, text: body }
      : kind === "task" ? { title, notes: body || undefined, subtasks: lines(items) }
      : { project: { name: title, description: body || undefined }, tasks: lines(items).map((x) => ({ title: x })) };
    try { await api.post("/templates", { kind, name: name || undefined, description, data }); reset(); onDone(); }
    catch (err) { showError(err as Error); } finally { setBusy(false); }
  };
  const titleLabel = kind === "doc" ? "Doc title" : kind === "task" ? "Task title" : "Project name";
  return (
    <Dialog open={open} onClose={onClose} title="New template" description="Write a template once and reuse it for every bug report, release note or project kick-off.">
      <form onSubmit={submit} className="space-y-4 px-6 pb-6 pt-4">
        <Field label="Kind">{(p) => <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as Template["kind"])}><option value="task">Task</option><option value="doc">Doc</option><option value="project">Project</option></Select>}</Field>
        <Field label="Template name (optional)">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "doc" ? "Release note" : kind === "task" ? "Bug report" : "Product launch"} />}</Field>
        <Field label={titleLabel}>{(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} required />}</Field>
        <Field label={kind === "doc" ? "Body" : kind === "task" ? "Notes (optional)" : "Description (optional)"} hint={kind === "doc" ? "One paragraph per line. Start a line with # for a heading or - for a bullet." : undefined}>
          {(p) => <Textarea {...p} rows={kind === "doc" ? 8 : 3} value={body} onChange={(e) => setBody(e.target.value)} />}
        </Field>
        {kind !== "doc" && <Field label={kind === "task" ? "Subtasks, one per line" : "Tasks, one per line"}>{(p) => <Textarea {...p} rows={4} value={items} onChange={(e) => setItems(e.target.value)} />}</Field>}
        <Field label="Description of the template (optional)">{(p) => <Input {...p} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}><IconDocs className="h-4 w-4" />Save template</Button></div>
      </form>
    </Dialog>
  );
}
