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
import { Link } from "react-router";
import { useConfig } from "@/web/lib/queries";
import { tr } from "@/web/i18n"; // R104B
import "@/web/i18n/w2/en-docs"; // R104B

interface Template { id: string; kind: "project" | "task" | "doc"; name: string; description: string; category: string; builtin: boolean; taskCount: number }
interface Project { id: string; name: string }

const today = () => new Date().toISOString().slice(0, 10);

export function TemplatesPage() {
  const contracts = !!useConfig().data?.contractsR108; // R108
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
    if (!(await confirm({ title: tr("docs.delete_the_template_name", { name: t.name }), description: tr("docs.projects_made_from_it_stay_as_they_are"), confirmLabel: tr("docs.delete_template") }))) return;
    try { await api.del(`/templates/${t.id}`); await qc.invalidateQueries({ queryKey: ["templates"] }); } catch (e) { showError(e as Error); }
  };
  const card = (t: Template) => (
    <Card key={t.id} className="flex h-full flex-col gap-3 p-5 transition-shadow duration-150 hover:shadow-md motion-reduce:transition-none" data-testid="template-card">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0"><h3 className="text-[15px] font-semibold leading-6">{t.name}</h3><p className="mt-0.5 text-[12px] text-subtle">{t.category} · {t.kind === "project" ? tr("docs.project_taskcount_tasks", { taskCount: t.taskCount }) : t.kind === "doc" ? "doc" : "task"}</p></div>
        {!t.builtin && <Button variant="ghost" size="icon" aria-label={tr("docs.delete_name", { name: t.name })} onClick={() => void remove(t)}><IconTrash className="h-4 w-4" /></Button>}
      </div>
      {t.description && <p className="text-[13.5px] text-muted">{t.description}</p>}
      <div className="mt-auto pt-2"><Button size="sm" variant="secondary" className="w-full sm:w-auto" onClick={() => setUsing(t)}>{tr("docs.use_template")}</Button></div>
    </Card>
  );
  return (
    <div>
      {dialogs}
      <PageHeader title={tr("nav.project_templates")} description={tr("docs.start_a_project_with_its_statuses_fields_and_tas")}
        actions={<div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" onClick={() => setSaving(true)}>{tr("docs.save_a_project_as_a_template")}</Button><Button size="sm" onClick={() => setWriting(true)}><IconPlus className="h-4 w-4" />{tr("docs.new_template")}</Button></div>} />
      {contracts && (
        <Card data-testid="contracts-entry" className="mb-5 flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="min-w-0"><p className="text-[14px] font-semibold">{tr("docs.contract_templates")}</p><p className="text-[13px] text-muted">{tr("docs.service_agreements_ndas_contractor_agreements_qu")}</p></div>
          <Link to="/app/tools/templates?view=contracts" className="shrink-0 text-[13px] font-medium text-brand hover:underline">{tr("docs.open_contracts")}</Link>
        </Card>
      )}
      {q.isPending ? <Skeleton className="h-64" /> : (
        <>
          <h2 className="mb-3 text-[15px] font-semibold">{tr("docs.starter_gallery")}</h2>
          <div className="mm-card-grid">{starters.map(card)}</div>
          <h2 className="mb-3 mt-8 text-[15px] font-semibold">{tr("docs.your_templates")}</h2>
          {mine.length ? <div className="mm-card-grid">{mine.map(card)}</div>
            : <EmptyState icon={<IconTemplate />} title={tr("docs.no_saved_templates_yet")} body="Write one from scratch with New template, save any project as a template, or save a task from its menu." />}
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
    <Dialog open={!!t} onClose={onClose} title={t ? tr("docs.use_name", { name: t.name }) : tr("docs.use_template")}>
      <form onSubmit={submit} className="space-y-4 px-6 pb-6 pt-4">
        <Field label={t?.kind === "task" ? tr("docs.task_title_optional") : t?.kind === "doc" ? tr("docs.doc_title_optional") : tr("docs.project_name_optional")}>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder={t?.name} />}</Field>
        {t?.kind === "task" && <Field label={tr("taskgroup.project")}>{(p) => <Select {...p} value={projectId} onChange={(e) => setProjectId(e.target.value)} required><option value="">{tr("docs.choose_a_project")}</option>{projects.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>}
        {t?.kind === "doc" && <Field label={tr("docs.project_optional")}>{(p) => <Select {...p} value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">{tr("docs.no_project")}</option>{projects.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>}
        {t?.kind !== "doc" && <Field label={tr("tasksort.start_date")}>{(p) => <Input {...p} type="date" value={start} onChange={(e) => setStart(e.target.value)} />}</Field>}
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>{tr("common.cancel")}</Button><Button type="submit" loading={busy}>{tr("common.create")}</Button></div>
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
    <Dialog open={open} onClose={onClose} title={tr("docs.save_a_project_as_a_template")} description={tr("docs.statuses_custom_fields_top_level_tasks_with_thei")}>
      <form onSubmit={submit} className="space-y-4 px-6 pb-6 pt-4">
        <Field label={tr("taskgroup.project")}>{(p) => <Select {...p} value={projectId} onChange={(e) => setProjectId(e.target.value)} required><option value="">{tr("docs.choose_a_project")}</option>{projects.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
        <Field label={tr("docs.template_name_optional")}>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label={tr("docs.description_optional")}>{(p) => <Input {...p} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>{tr("common.cancel")}</Button><Button type="submit" loading={busy}>{tr("docs.save_template")}</Button></div>
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
    <Dialog open={open} onClose={onClose} title={tr("docs.new_template")} description={tr("docs.write_a_template_once_and_reuse_it_for_every_bug")}>
      <form onSubmit={submit} className="space-y-4 px-6 pb-6 pt-4">
        <Field label={tr("docs.kind")}>{(p) => <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as Template["kind"])}><option value="task">{tr("nav.task")}</option><option value="doc">{tr("nav.doc")}</option><option value="project">{tr("taskgroup.project")}</option></Select>}</Field>
        <Field label={tr("docs.template_name_optional")}>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "doc" ? tr("docs.release_note") : kind === "task" ? tr("docs.bug_report") : tr("docs.product_launch")} />}</Field>
        <Field label={titleLabel}>{(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} required />}</Field>
        <Field label={kind === "doc" ? tr("docs.body") : kind === "task" ? tr("docs.notes_optional") : tr("docs.description_optional")} hint={kind === "doc" ? tr("docs.one_paragraph_per_line_start_a_line_with_for_a_h") : undefined}>
          {(p) => <Textarea {...p} rows={kind === "doc" ? 8 : 3} value={body} onChange={(e) => setBody(e.target.value)} />}
        </Field>
        {kind !== "doc" && <Field label={kind === "task" ? tr("docs.subtasks_one_per_line") : tr("docs.tasks_one_per_line")}>{(p) => <Textarea {...p} rows={4} value={items} onChange={(e) => setItems(e.target.value)} />}</Field>}
        <Field label={tr("docs.description_of_the_template_optional")}>{(p) => <Input {...p} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>{tr("common.cancel")}</Button><Button type="submit" loading={busy}><IconDocs className="h-4 w-4" />{tr("docs.save_template")}</Button></div>
      </form>
    </Dialog>
  );
}
