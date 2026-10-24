/** Templates: the starter gallery and saved project and task templates. */
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LayoutTemplate, Trash2 } from "lucide-react";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select } from "@/web/components/ui/input";
import { Card, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";

interface Template { id: string; kind: "project" | "task"; name: string; description: string; category: string; builtin: boolean; taskCount: number }
interface Project { id: string; name: string }

const today = () => new Date().toISOString().slice(0, 10);

export function TemplatesPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [using, setUsing] = useState<Template | null>(null);
  const [saving, setSaving] = useState(false);
  const q = useQuery({ queryKey: ["templates"], queryFn: async () => (await api.get<{ templates: Template[] }>("/templates")).templates });
  const projects = useQuery({ queryKey: ["projects"], queryFn: async () => (await api.get<{ projects: Project[] }>("/projects")).projects });
  const starters = (q.data ?? []).filter((t) => t.builtin);
  const mine = (q.data ?? []).filter((t) => !t.builtin);
  const remove = async (t: Template) => {
    if (!window.confirm(`Delete the template "${t.name}"? Projects made from it stay.`)) return;
    try { await api.del(`/templates/${t.id}`); await qc.invalidateQueries({ queryKey: ["templates"] }); } catch (e) { showError(e as Error); }
  };
  const card = (t: Template) => (
    <Card key={t.id} className="flex flex-col gap-2" data-testid="template-card">
      <div className="flex items-start justify-between gap-2">
        <div><h3 className="font-semibold">{t.name}</h3><p className="text-[12px] text-subtle">{t.category} · {t.kind === "project" ? `project, ${t.taskCount} tasks` : "task"}</p></div>
        {!t.builtin && <Button variant="ghost" size="icon" aria-label={`Delete ${t.name}`} onClick={() => void remove(t)}><Trash2 className="h-4 w-4" /></Button>}
      </div>
      {t.description && <p className="text-[13.5px] text-muted">{t.description}</p>}
      <div className="mt-auto pt-1"><Button size="sm" onClick={() => setUsing(t)}>Use template</Button></div>
    </Card>
  );
  return (
    <div>
      <PageHeader title="Templates" description="Start a project with its statuses, fields and tasks already in place. Due dates count from the start date you pick."
        actions={<Button size="sm" variant="secondary" onClick={() => setSaving(true)}>Save a project as a template</Button>} />
      {q.isPending ? <Skeleton className="h-64" /> : (
        <>
          <h2 className="mb-3 text-[15px] font-semibold">Starter gallery</h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{starters.map(card)}</div>
          <h2 className="mb-3 mt-8 text-[15px] font-semibold">Your templates</h2>
          {mine.length ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{mine.map(card)}</div>
            : <EmptyState icon={<LayoutTemplate />} title="No saved templates yet" body="Save any project as a template, or save a task from its menu, to reuse it." />}
        </>
      )}
      <UseDialog t={using} projects={projects.data ?? []} onClose={() => setUsing(null)} onDone={(r) => {
        setUsing(null); void qc.invalidateQueries({ queryKey: ["projects"] });
        navigate(r.project ? `/app/tasks?project=${r.project.id}&view=list` : `/app/tasks?task=${r.task!.id}`);
      }} />
      <SaveDialog open={saving} projects={projects.data ?? []} onClose={() => setSaving(false)} onDone={() => { setSaving(false); void qc.invalidateQueries({ queryKey: ["templates"] }); }} />
    </div>
  );
}

function UseDialog({ t, projects, onClose, onDone }: { t: Template | null; projects: Project[]; onClose: () => void; onDone: (r: { project?: { id: string }; task?: { id: string } }) => void }) {
  const [name, setName] = useState(""); const [start, setStart] = useState(today()); const [projectId, setProjectId] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (!t) return; setBusy(true);
    try { onDone(await api.post(`/templates/${t.id}/use`, { name: name || undefined, startDate: start || undefined, projectId: t.kind === "task" ? projectId : undefined })); setName(""); }
    catch (err) { showError(err as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open={!!t} onClose={onClose} title={t ? `Use "${t.name}"` : "Use template"}>
      <form onSubmit={submit} className="space-y-4 px-6 pb-6 pt-4">
        <Field label={t?.kind === "task" ? "Task title (optional)" : "Project name (optional)"}>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder={t?.name} />}</Field>
        {t?.kind === "task" && <Field label="Project">{(p) => <Select {...p} value={projectId} onChange={(e) => setProjectId(e.target.value)} required><option value="">Choose a project</option>{projects.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>}
        <Field label="Start date">{(p) => <Input {...p} type="date" value={start} onChange={(e) => setStart(e.target.value)} />}</Field>
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
