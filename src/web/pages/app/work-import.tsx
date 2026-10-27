import { useRef, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { IconArrowRight, IconChecklist, IconFileUp } from "@/web/components/ui/icon";
import { api, ApiError } from "@/web/lib/api";
import { Badge } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Field, Input, Select } from "@/web/components/ui/input";
import { useProjects } from "./work/data";
import { ImportSection } from "./import-section";
import { Section } from "./settings";

type Group = "todo" | "doing" | "done";
type Mapping = Record<string, string | null>;
interface PreviewRow { title: string; status: string | null; group: Group | null; assignees: string[]; due: string | null; start: string | null; priority: string; labels: string[]; parent: string | null; comments: number }
interface Preview {
  source: string; sourceLabel: string; name: string | null; headers: string[]; fields: { id: string; label: string }[]; mapping: Mapping;
  total: number; skipped: number; alreadyImported: number; subtasks: number; rows: PreviewRow[]; statuses: { name: string; category: Group }[];
  unknownAssignees: string[]; leftToday: number;
}
interface RunResult { projectId: string | null; projectName: string | null; created: number; alreadyThere: number; left: number; comments: number; unknownAssignees: number; stopped: null | "daily_cap" | "write_budget" | "time"; sourceLabel: string }

const GROUP: Record<Group, { label: string; tone: "neutral" | "brand" | "ok" }> = { todo: { label: "To do", tone: "neutral" }, doing: { label: "Doing", tone: "brand" }, done: { label: "Done", tone: "ok" } };
const MAX_BYTES = 6_000_000;

function toBase64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Settings, Import: work tools first, then the mail import (shown to admins when it is switched on). */
export function ImportSettings() {
  return (
    <div className="space-y-6">
      <WorkToolsImport />
      <ImportSection />
    </div>
  );
}

function stoppedText(r: RunResult) {
  if (!r.stopped || !r.left) return null;
  if (r.stopped === "daily_cap") return `${r.left} more wait for tomorrow: a workspace can bring in 2,000 tasks a day. Upload the same file tomorrow and it carries on where it stopped.`;
  if (r.stopped === "write_budget") return `${r.left} more wait for now: Multies is pausing big imports for today. Upload the same file again tomorrow and it carries on.`;
  return `${r.left} more to go. Press Import again with the same file and it carries on where it stopped.`;
}

/** Trello, Asana, ClickUp, monday, Jira, Linear and Notion exports into a project, with a column mapping and a preview. */
export function WorkToolsImport() {
  const qc = useQueryClient();
  const projects = useProjects();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [target, setTarget] = useState("");
  const [projectName, setProjectName] = useState("");
  const [result, setResult] = useState<RunResult | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  const preview = useMutation({
    mutationFn: (b: { name: string; content: string; mapping?: Mapping }) => api.post<Preview>("/work-imports/preview", { fileName: b.name, content: b.content, mapping: b.mapping }),
    onSuccess: (p, b) => {
      setMapping(p.mapping);
      if (!b.mapping) setProjectName(p.name ?? b.name.replace(/\.(csv|json|xlsx)$/i, ""));
    },
  });
  const run = useMutation({
    mutationFn: () => api.post<RunResult>("/work-imports/run", { fileName: file!.name, content: file!.content, mapping, projectId: target || null, projectName: target ? null : projectName }),
    onSuccess: (r) => {
      setResult(r);
      qc.invalidateQueries();
      if (file) preview.mutate({ ...file, mapping: mapping ?? undefined });
    },
  });

  const pick = async (f: File | undefined) => {
    setResult(null); setFileError(null); setMapping(null); preview.reset();
    if (!f) return;
    if (f.size > MAX_BYTES) { setFileError("This file is over 6 MB. Export a smaller part, or split it."); return; }
    // An .xlsx (monday's default export) goes as base64; the server reads its first sheet.
    const content = /\.xlsx$/i.test(f.name) ? `xlsx-base64:${toBase64(new Uint8Array(await f.arrayBuffer()))}` : await f.text();
    setFile({ name: f.name, content });
    preview.mutate({ name: f.name, content });
  };
  const remap = (field: string, header: string) => {
    const next = { ...mapping, [field]: header || null };
    setMapping(next);
    if (file) preview.mutate({ ...file, mapping: next });
  };

  const p = preview.data;
  const err = (preview.error instanceof ApiError ? preview.error.message : null) ?? fileError;
  return (
    <Section id="work-tools" title="Work tools" description="Bring boards and task lists over from Trello, Asana, ClickUp, monday.com, Jira, Linear or Notion. Export a CSV file (JSON from Trello, Excel or CSV from monday.com), upload it, check the columns, and import. Running it again with the same file only adds what is new.">
      <div className="space-y-5">
        {/* R38 premium pass 3: a drop zone with the three steps, instead of a lone button on an empty card. */}
        {!file && (
          <div
            role="button" tabIndex={0} data-testid="import-drop"
            onClick={() => input.current?.click()}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.current?.click(); } }}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); void pick(e.dataTransfer.files?.[0]); }}
            className={"group grid cursor-pointer place-items-center rounded-xl border-[1.5px] border-dashed px-6 py-8 text-center transition-[background-color,border-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 motion-reduce:transition-none " + (over ? "scale-[1.01] border-brand bg-brand-soft" : "border-line-strong bg-fill/40 hover:border-brand/60 hover:bg-brand-soft/40")}
          >
            <span className="mb-3 grid h-11 w-11 place-items-center rounded-xl bg-surface text-[#0071E3] shadow-[0_0_0_0.5px_rgb(0_0_0/0.06),0_2px_6px_rgb(0_0_0/0.08)] [&_svg]:h-5 [&_svg]:w-5" aria-hidden><IconFileUp /></span>
            <p className="text-[14px] font-semibold">Drop an export file here, or choose one</p>
            <p className="mt-1 text-[12.5px] text-muted">CSV, JSON or Excel. Running it again only adds what is new.</p>
            <ol className="mt-4 flex flex-wrap justify-center gap-2 text-[12px] text-muted">
              {["Export from your old tool", "Drop the file here", "Check the columns, then import"].map((t, i) => (
                <li key={t} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1"><span className="grid h-4 w-4 place-items-center rounded-full bg-brand text-[10px] font-semibold text-white">{i + 1}</span>{t}</li>
              ))}
            </ol>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <input ref={input} type="file" accept=".csv,.json,.xlsx,text/csv,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="Export file" className="sr-only" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
          <Button size="sm" variant="outline" onClick={() => input.current?.click()} loading={preview.isPending && !p}><IconFileUp className="h-4 w-4" aria-hidden />{file ? "Choose another file" : "Choose file"}</Button>
          {file && <span className="min-w-0 truncate text-sm text-muted">{file.name}</span>}
          {p && <Badge tone="brand">{p.source === "csv" ? "CSV file" : `From ${p.sourceLabel}`}</Badge>}
        </div>
        {err && <p className="text-sm text-bad" role="alert">{err}</p>}

        {p && mapping && (
          <>
            <p className="text-sm text-muted">
              {p.total} tasks{p.subtasks ? `, ${p.subtasks} of them subtasks` : ""}{p.skipped ? `. ${p.skipped} rows have no title and are left out` : ""}.
              {p.alreadyImported ? ` ${p.alreadyImported} are already in Multies and will be skipped.` : ""}
            </p>

            <div>
              <h3 className="mb-2 text-[13px] font-semibold">Columns</h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {p.fields.map((f) => (
                  <Field key={f.id} label={f.label}>{(props) => (
                    <Select {...props} value={mapping[f.id] ?? ""} onChange={(e) => remap(f.id, e.target.value)}>
                      <option value="">{f.id === "title" ? "Choose a column" : "Not used"}</option>
                      {p.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                    </Select>
                  )}</Field>
                ))}
              </div>
            </div>

            {!!p.statuses.length && (
              <div>
                <h3 className="mb-2 text-[13px] font-semibold">Statuses</h3>
                <ul className="flex flex-wrap gap-2 text-sm">
                  {p.statuses.map((s) => <li key={s.name} className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1">{s.name}<Badge tone={GROUP[s.category].tone}>{GROUP[s.category].label}</Badge></li>)}
                </ul>
              </div>
            )}

            <div>
              <h3 className="mb-2 text-[13px] font-semibold">Preview{p.total > 20 ? " of the first 20" : ""}</h3>
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full min-w-[560px] text-left text-[13px]" aria-label="Import preview">
                  <thead className="bg-fill text-muted"><tr><th className="px-3 py-2 font-medium">Title</th><th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 font-medium">Assignee</th><th className="px-3 py-2 font-medium">Due</th><th className="px-3 py-2 font-medium">Parent</th><th className="px-3 py-2 font-medium">Labels</th></tr></thead>
                  <tbody className="divide-y divide-line">
                    {p.rows.map((r, i) => (
                      <tr key={i}>
                        <td className="max-w-[240px] truncate px-3 py-2">{r.title}</td>
                        <td className="px-3 py-2">{r.status ?? (r.group ? GROUP[r.group].label : "")}</td>
                        <td className="max-w-[160px] truncate px-3 py-2">{r.assignees.join(", ")}</td>
                        <td className="whitespace-nowrap px-3 py-2 tabular-nums">{r.due ?? ""}</td>
                        <td className="max-w-[140px] truncate px-3 py-2 text-muted">{r.parent ?? ""}</td>
                        <td className="max-w-[140px] truncate px-3 py-2 text-muted">{r.labels.join(", ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!!p.unknownAssignees.length && (
                <p className="mt-2 text-xs text-subtle">Not in this workspace, so kept as a note on the task: {p.unknownAssignees.slice(0, 8).join(", ")}{p.unknownAssignees.length > 8 ? ` and ${p.unknownAssignees.length - 8} more` : ""}. Nobody is added as a member.</p>
              )}
            </div>

            <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); run.mutate(); }}>
              <Field label="Into project">{(props) => (
                <Select {...props} value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">A new project</option>
                  {projects.data?.filter((x) => !x.archived).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </Select>
              )}</Field>
              {!target && <Field label="Project name">{(props) => <Input {...props} value={projectName} maxLength={120} onChange={(e) => setProjectName(e.target.value)} />}</Field>}
              <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
                <Button type="submit" size="sm" loading={run.isPending} disabled={!mapping.title || !p.total || p.alreadyImported >= p.total}><IconChecklist className="h-4 w-4" aria-hidden />{p.alreadyImported >= p.total ? "All tasks are in" : `Import ${p.total - p.alreadyImported} tasks`}</Button>
                {p.leftToday < p.total - p.alreadyImported && <span className="text-xs text-subtle">{p.leftToday} can come in today; the rest tomorrow.</span>}
              </div>
              {run.error instanceof ApiError && <p className="text-sm text-bad sm:col-span-2">{run.error.message}</p>}
            </form>
          </>
        )}

        {result && (
          <div className="rounded-lg border border-line bg-fill/50 p-4 text-sm" role="status">
            <p className="font-medium">{result.created ? `Imported ${result.created} tasks${result.projectName ? ` into ${result.projectName}` : ""}.` : result.left ? "Nothing imported yet." : "Everything in this file is already in Multies."}</p>
            {(result.comments > 0 || result.unknownAssignees > 0) && <p className="mt-1 text-muted">{result.comments ? `${result.comments} comments. ` : ""}{result.unknownAssignees ? `${result.unknownAssignees} tasks keep their old assignee as a note.` : ""}</p>}
            {stoppedText(result) && <p className="mt-1 text-muted">{stoppedText(result)}</p>}
            {result.projectId && <Link to={`/app/tasks?project=${result.projectId}&view=list`} className="mt-2 inline-flex items-center gap-1 font-medium text-brand hover:underline">Open project<IconArrowRight className="h-4 w-4" aria-hidden /></Link>}
          </div>
        )}
      </div>
    </Section>
  );
}
