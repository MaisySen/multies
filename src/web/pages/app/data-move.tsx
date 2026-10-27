/**
 * R38 move your data: Settings, Import and export. A team brings its work in from the tools it uses now (a wizard with
 * column, people and status mapping, a 20 row preview, a progress ring and Undo) and can leave with everything
 * (one ZIP: JSON, CSV, Markdown, calendar, contacts and mail, behind a link that works for 24 hours).
 * Source app names appear only in the picker and its help text, so people can find their tool.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  IconArrowLeft, IconArrowRight, IconBoard, IconCalendar, IconChat, IconMail, IconCheck, IconCheckCircle, IconChecklist, IconContacts, IconDatabaseBackup, IconDocs,
  IconDownload, IconFileUp, IconHistory, IconSheet, IconTable, IconTasks, IconUndo, IconUpload, IconWarning,
} from "@/web/components/ui/icon";
import { api, ApiError } from "@/web/lib/api";
import { useMe } from "@/web/lib/queries";
import { timeAgo } from "@/web/lib/format";
import { Badge, CopyButton, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { ConfirmDialog } from "@/web/components/ui/confirm";
import { Field, Input, Select } from "@/web/components/ui/input";
import { useAssignees, useProjects } from "./work/data";
import { ImportSection } from "./import-section";
import { Section } from "./settings";

type Kind = "tasks" | "calendar" | "contacts" | "docs" | "workspace";
type Group = "todo" | "doing" | "done";
type Mapping = Record<string, string | null>;
interface Move {
  id: string; kind: "import" | "export"; source: string; fileName: string | null; status: "running" | "stopped" | "done" | "undone" | "failed" | "ready" | "expired";
  projectId: string | null; total: number; done: number; counts: Record<string, number>; created: number; canUndo: boolean; expiresAt: string | null; by: string | null; createdAt: string; finishedAt: string | null;
}
interface TaskPreview {
  kind: "tasks"; source: string; sourceLabel: string; name: string | null; headers: string[]; fields: { id: string; label: string }[]; mapping: Mapping;
  total: number; skipped: number; alreadyImported: number; subtasks: number; statuses: { name: string; category: Group }[]; unknownAssignees: string[]; leftToday: number;
  rows: { title: string; status: string | null; group: Group | null; assignees: string[]; due: string | null; parent: string | null; labels: string[] }[];
}
interface OtherPreview { kind: "calendar" | "contacts" | "docs" | "workspace"; total: number; skipped?: number; alreadyThere?: number; parts?: Record<string, number>; rows?: Record<string, unknown>[] }
type Preview = TaskPreview | OtherPreview;
interface RunAnswer { move: Move; stopped: string | null }

interface Source { id: string; kind: Kind; label: string; hint: string; how: string; accept: string; icon: ReactNode; tint: string }

/** The picker. App names live here and in the help text only. */
export const SOURCES: Source[] = [
  { id: "csv", kind: "tasks", label: "CSV or Excel", hint: "Any spreadsheet", how: "Save the sheet as CSV or Excel (.xlsx). The first row names the columns: a title column is all you need.", accept: ".csv,.xlsx,text/csv", icon: <IconSheet />, tint: "#34C759" },
  { id: "trello", kind: "tasks", label: "Trello", hint: "Board JSON", how: "Open the board, then Menu, Print, export and share, Export as JSON. Lists become statuses, checklists stay with their cards.", accept: ".json,application/json", icon: <IconBoard />, tint: "#0C66E4" },
  { id: "asana", kind: "tasks", label: "Asana", hint: "Project CSV", how: "Open the project, the arrow next to its name, Export, CSV. Sections become statuses and subtasks stay under their parents.", accept: ".csv,text/csv", icon: <IconChecklist />, tint: "#F06A6A" },
  { id: "clickup", kind: "tasks", label: "ClickUp", hint: "List CSV", how: "Open the List view, the view menu, Export view, CSV with all columns.", accept: ".csv,text/csv", icon: <IconTasks />, tint: "#7B68EE" },
  { id: "jira", kind: "tasks", label: "Jira", hint: "Issues CSV", how: "Search work items, Export, Export CSV (all fields). Status categories, parents and comments come across.", accept: ".csv,text/csv", icon: <IconTable />, tint: "#1868DB" },
  { id: "monday", kind: "tasks", label: "monday.com", hint: "Board Excel or CSV", how: "Open the board, the three dots menu, More actions, Export board to Excel. Groups and subitems come across.", accept: ".xlsx,.csv,text/csv", icon: <IconBoard />, tint: "#FF3D57" },
  { id: "notion", kind: "tasks", label: "Notion", hint: "Markdown and CSV zip", how: "Open the database as a full page, the three dots menu, Export, Markdown and CSV. Upload the zip: each row's page becomes its description.", accept: ".zip,.csv,application/zip,text/csv", icon: <IconDocs />, tint: "#37352F" },
  { id: "todoist", kind: "tasks", label: "Todoist", hint: "Project CSV", how: "Open the project, the three dots, Manage data, Export as CSV. Sections become statuses and notes become comments.", accept: ".csv,text/csv", icon: <IconCheckCircle />, tint: "#E44332" },
  { id: "linear", kind: "tasks", label: "Linear", hint: "Issues CSV", how: "Settings, Administration, Import and export, Export data. Upload the CSV it sends you.", accept: ".csv,text/csv", icon: <IconTasks />, tint: "#5E6AD2" },
  { id: "calendar", kind: "calendar", label: "Calendar", hint: ".ics file", how: "Export or download your calendar as an .ics file from any calendar app. Events become meetings; nobody is sent an invite.", accept: ".ics,text/calendar", icon: <IconCalendar />, tint: "#FF9500" },
  { id: "contacts", kind: "contacts", label: "Contacts", hint: "vCard or CSV", how: "Export your address book as a .vcf file, or a CSV with an email column. People already in Contacts are skipped.", accept: ".vcf,.csv,text/vcard,text/csv", icon: <IconContacts />, tint: "#30B0C7" },
  { id: "docs", kind: "docs", label: "Docs", hint: "Markdown or a zip", how: "Upload a Markdown file (.md) or a zip of them. Headings, lists, tables and links come across.", accept: ".md,.markdown,.txt,.zip,text/markdown,application/zip", icon: <IconDocs />, tint: "#AF52DE" },
  { id: "workspace", kind: "workspace", label: "From another Multies workspace", hint: "Workspace ZIP", how: "The ZIP from Export workspace, from this or another workspace. Projects, tasks, contacts, meetings and docs come back.", accept: ".zip,application/zip", icon: <IconDatabaseBackup />, tint: "#0071E3" },
];

const MAX_BYTES = 6_000_000;
const GROUP: Record<Group, { label: string; tone: "neutral" | "brand" | "ok" }> = { todo: { label: "To do", tone: "neutral" }, doing: { label: "Doing", tone: "brand" }, done: { label: "Done", tone: "ok" } };

function toBase64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function readUpload(f: File) {
  if (/\.xlsx$/i.test(f.name)) return `xlsx-base64:${toBase64(new Uint8Array(await f.arrayBuffer()))}`;
  if (/\.zip$/i.test(f.name)) return `zip-base64:${toBase64(new Uint8Array(await f.arrayBuffer()))}`;
  return f.text();
}

/** A calm progress ring: the arc eases between values in 200 ms (none with reduced motion). */
export function ProgressRing({ value, size = 72, label }: { value: number | null; size?: number; label: string }) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const pct = value === null ? 0.25 : Math.max(0, Math.min(1, value));
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : Math.round(pct * 100)}>
      <svg width={size} height={size} className={value === null ? "animate-spin motion-reduce:animate-none" : ""} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={6} className="stroke-fill" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={6} strokeLinecap="round" stroke="#0071E3"
          strokeDasharray={c} strokeDashoffset={c * (1 - pct)} transform={`rotate(-90 ${size / 2} ${size / 2})`}
          className="transition-[stroke-dashoffset] duration-200 ease-out motion-reduce:transition-none" />
      </svg>
      {value !== null && <span className="absolute text-[13px] font-semibold tabular-nums">{Math.round(pct * 100)}%</span>}
    </div>
  );
}

function Tile({ s, onPick, active }: { s: Source; onPick: () => void; active: boolean }) {
  return (
    <button type="button" onClick={onPick} data-testid={`move-source-${s.id}`} aria-pressed={active}
      className={"group flex min-h-[64px] w-full min-w-0 items-center gap-3 rounded-xl border bg-surface px-3 py-2.5 text-left shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-px hover:shadow-[0_4px_14px_rgb(0_0_0/0.08)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 motion-reduce:transition-none motion-reduce:hover:translate-y-0 " + (active ? "border-brand ring-1 ring-brand/40" : "border-line")}>
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] text-white [&_svg]:h-[18px] [&_svg]:w-[18px]" style={{ background: s.tint }} aria-hidden>{s.icon}</span>
      <span className="min-w-0">
        <span className="block break-words text-[13.5px] font-semibold leading-snug">{s.label}</span>
        <span className="block text-[12px] leading-snug text-muted">{s.hint}</span>
      </span>
    </button>
  );
}

const STEPS: Record<"tasks" | "other", string[]> = { tasks: ["Upload", "Columns", "People and statuses", "Preview", "Import"], other: ["Upload", "Preview", "Import"] };

function Stepper({ steps, at }: { steps: string[]; at: number }) {
  return (
    <ol className="flex items-center gap-x-2 gap-y-1.5 overflow-x-auto text-[12.5px] sm:flex-wrap" aria-label="Import steps">
      {steps.map((s, i) => (
        <li key={s} className="flex shrink-0 items-center gap-2" aria-current={i === at ? "step" : undefined}>
          <span className={"grid h-5 w-5 place-items-center rounded-full text-[11px] font-semibold transition-colors duration-150 " + (i < at ? "bg-ok text-white" : i === at ? "bg-brand text-white" : "bg-fill text-muted")}>{i < at ? <IconCheck className="h-3 w-3" aria-hidden /> : i + 1}</span>
          <span className={i === at ? "font-semibold" : "text-muted max-sm:sr-only"}>{s}</span>
          {i < steps.length - 1 && <span className="h-px w-3 bg-line-strong sm:w-6" aria-hidden />}
        </li>
      ))}
    </ol>
  );
}

/** Settings, Import and export. */
export function ImportExportSettings() {
  const me = useMe();
  const isAdmin = me.data?.organization?.role !== "member";
  const [source, setSource] = useState<Source | null>(null);
  const wizardRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (source) wizardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }, [source]);
  return (
    <div className="space-y-6" data-testid="import-export">
      <Section id="move-in" title="Bring your work in" description="Pick where your work lives now. You check the columns, people and statuses, see the first 20 rows, and can undo the whole import later.">
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(176px,1fr))]" role="list" aria-label="Import from">
          {SOURCES.map((s) => <div role="listitem" key={s.id} className="min-w-0"><Tile s={s} active={source?.id === s.id} onPick={() => setSource(s)} /></div>)}
        </div>
      </Section>
      <div ref={wizardRef} className="scroll-mt-6 empty:hidden">
        {source && <ImportWizard key={source.id} source={source} onClose={() => setSource(null)} />}
      </div>
      {isAdmin && <ExportCard />}
      <HistoryCard />
      <ImportSection />
    </div>
  );
}

// ------------------------------------------------------------------ wizard

function ImportWizard({ source, onClose }: { source: Source; onClose: () => void }) {
  const qc = useQueryClient();
  const projects = useProjects();
  const people = useAssignees();
  const input = useRef<HTMLInputElement>(null);
  const isTasks = source.kind === "tasks";
  const steps = STEPS[isTasks ? "tasks" : "other"];
  const [step, setStep] = useState(0);
  const [over, setOver] = useState(false);
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [target, setTarget] = useState("");
  const [projectName, setProjectName] = useState("");
  const [who, setWho] = useState<Record<string, string>>({});
  const [statusMap, setStatusMap] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<{ move: Move; stopped: string | null } | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const preview = useMutation({
    mutationFn: (b: { name: string; content: string; mapping?: Mapping }) => api.post<Preview>("/data-moves/imports/preview", { kind: source.kind, fileName: b.name, content: b.content, mapping: b.mapping }),
    onSuccess: (p, b) => {
      if (p.kind === "tasks") { setMapping(p.mapping); if (!b.mapping) setProjectName(p.name ?? b.name.replace(/\.(csv|json|xlsx|zip)$/i, "")); }
      if (!b.mapping) setStep(1);
    },
  });
  const p = preview.data;
  const tp = p?.kind === "tasks" ? p : null;
  const project = projects.data?.find((x) => x.id === target);

  const pick = async (f: File | undefined) => {
    setFileError(null); setMapping(null); preview.reset(); setProgress(null);
    if (!f) return;
    if (f.size > MAX_BYTES) { setFileError("This file is over 6 MB. Export a smaller part, or split it."); return; }
    const content = await readUpload(f);
    setFile({ name: f.name, content });
    preview.mutate({ name: f.name, content });
  };
  const remap = (field: string, header: string) => {
    const next = { ...mapping, [field]: header || null };
    setMapping(next);
    if (file) preview.mutate({ ...file, mapping: next });
  };

  /** Runs step after step until the server says done (each step is about 15 seconds of work). */
  const start = async () => {
    if (!file) return;
    setRunning(true); setRunError(null); setStep(steps.length - 1);
    let moveId: string | null = null;
    try {
      for (let i = 0; i < 400; i++) {
        const body: Record<string, unknown> = { kind: source.kind, fileName: file.name, content: file.content, mapping: mapping ?? undefined, moveId,
          projectId: target || null, projectName: target ? null : projectName,
          people: Object.fromEntries(Object.entries(who).map(([k, v]) => [k, v === "none" ? "" : v])),
          statusMap: Object.fromEntries(Object.entries(statusMap).filter(([, v]) => v)) };
        const r: RunAnswer = await api.post<RunAnswer>("/data-moves/imports/run", body);
        moveId = r.move.id;
        setProgress(r);
        if (r.move.status === "done" || r.stopped !== "time") break;
      }
      qc.invalidateQueries();
    } catch (e) {
      setRunError(e instanceof ApiError ? e.message : "The import stopped. Press Import again with the same file and it carries on.");
    } finally { setRunning(false); }
  };

  const next = () => setStep((s) => Math.min(steps.length - 2, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));
  const err = (preview.error instanceof ApiError ? preview.error.message : null) ?? fileError;
  const count = p ? (tp ? tp.total - tp.alreadyImported : p.kind === "contacts" ? p.total - (p.alreadyThere ?? 0) : p.total) : 0;
  const noun = source.kind === "tasks" ? "tasks" : source.kind === "calendar" ? "events" : source.kind === "contacts" ? "contacts" : source.kind === "docs" ? "pages" : "items";
  const pct = progress ? (progress.move.total ? progress.move.done / progress.move.total : progress.move.status === "done" ? 1 : null) : null;

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_rgb(0_0_0/0.06)] animate-in fade-in slide-in-from-bottom-1 duration-200 motion-reduce:animate-none" data-testid="move-wizard">
      <div className="space-y-3 border-b border-line bg-fill/40 px-4 py-3 md:px-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] text-white [&_svg]:h-4 [&_svg]:w-4" style={{ background: source.tint }} aria-hidden>{source.icon}</span>
            <h3 className="truncate text-[15px] font-semibold">Import from {source.label}</h3>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose} disabled={running}>Close</Button>
        </div>
        <Stepper steps={steps} at={step} />
      </div>

      <div className="space-y-4 p-4 md:p-6">
        {step === 0 && (
          <>
            <p className="rounded-lg bg-brand-soft/50 px-3 py-2 text-[13px] leading-relaxed text-fg">{source.how}</p>
            <div role="button" tabIndex={0} data-testid="move-drop"
              onClick={() => input.current?.click()}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.current?.click(); } }}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); void pick(e.dataTransfer.files?.[0]); }}
              className={"grid cursor-pointer place-items-center rounded-xl border-[1.5px] border-dashed px-6 py-8 text-center transition-[background-color,border-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 motion-reduce:transition-none " + (over ? "scale-[1.01] border-brand bg-brand-soft" : "border-line-strong bg-fill/40 hover:border-brand/60 hover:bg-brand-soft/40")}>
              {preview.isPending ? <ProgressRing value={null} size={44} label="Reading the file" /> : <span className="mb-3 grid h-11 w-11 place-items-center rounded-xl bg-surface text-[#0071E3] shadow-[0_0_0_0.5px_rgb(0_0_0/0.06),0_2px_6px_rgb(0_0_0/0.08)] [&_svg]:h-5 [&_svg]:w-5" aria-hidden><IconFileUp /></span>}
              <p className="mt-2 text-[14px] font-semibold">{file ? file.name : "Drop the file here, or choose one"}</p>
              <p className="mt-1 text-[12.5px] text-muted">Up to 6 MB. Running it again only adds what is new.</p>
            </div>
            <input ref={input} type="file" accept={source.accept} aria-label="File to import" className="sr-only" data-testid="move-file" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
            {err && <p className="flex items-center gap-1.5 text-sm text-bad" role="alert"><IconWarning className="h-4 w-4" aria-hidden />{err}</p>}
          </>
        )}

        {step === 1 && tp && mapping && (
          <>
            <p className="text-sm text-muted">{tp.total} tasks{tp.subtasks ? `, ${tp.subtasks} of them subtasks` : ""} found{tp.skipped ? `. ${tp.skipped} rows have no title and are left out` : ""}. Check which column feeds each field.</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {tp.fields.map((f) => (
                <Field key={f.id} label={f.label}>{(props) => (
                  <Select {...props} value={mapping[f.id] ?? ""} onChange={(e) => remap(f.id, e.target.value)}>
                    <option value="">{f.id === "title" ? "Choose a column" : "Not used"}</option>
                    {tp.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </Select>
                )}</Field>
              ))}
            </div>
          </>
        )}

        {step === 2 && tp && (
          <div className="grid gap-5 lg:grid-cols-2">
            <div>
              <h4 className="mb-1 text-[13px] font-semibold">People</h4>
              {tp.unknownAssignees.length ? (
                <>
                  <p className="mb-2 text-[12.5px] text-muted">These names are not members yet. Pick a member, or leave their tasks unassigned (the name stays on the task). <Link to="/app/settings/team" className="font-medium text-brand hover:underline">Invite them first</Link> to assign them later.</p>
                  <ul className="divide-y divide-line rounded-lg border border-line">
                    {tp.unknownAssignees.slice(0, 30).map((name) => (
                      <li key={name} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                        <span className="min-w-0 truncate text-[13px]">{name}</span>
                        <Select aria-label={`Assign tasks for ${name}`} className="w-48 max-sm:w-full" value={who[name] ?? "none"} onChange={(e) => setWho({ ...who, [name]: e.target.value })}>
                          <option value="none">Leave unassigned</option>
                          {people.data?.filter((x) => x.type === "member").map((m) => <option key={m.id} value={m.id}>{m.name || m.email}</option>)}
                        </Select>
                      </li>
                    ))}
                  </ul>
                </>
              ) : <p className="flex items-center gap-1.5 text-[13px] text-muted"><IconCheckCircle className="h-4 w-4 text-ok" aria-hidden />Everyone in the file is matched to a member by email or name.</p>}
            </div>
            <div className="space-y-3">
              <h4 className="text-[13px] font-semibold">Where it goes</h4>
              <Field label="Into project">{(props) => (
                <Select {...props} value={target} onChange={(e) => { setTarget(e.target.value); setStatusMap({}); }}>
                  <option value="">A new project</option>
                  {projects.data?.filter((x) => !x.archived).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </Select>
              )}</Field>
              {!target && <Field label="Project name">{(props) => <Input {...props} value={projectName} maxLength={120} onChange={(e) => setProjectName(e.target.value)} />}</Field>}
              {!!tp.statuses.length && (
                <div>
                  <h4 className="mb-1 text-[13px] font-semibold">Statuses</h4>
                  <ul className="divide-y divide-line rounded-lg border border-line">
                    {tp.statuses.map((s) => (
                      <li key={s.name} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                        <span className="flex min-w-0 items-center gap-2 text-[13px]"><span className="truncate">{s.name}</span><Badge tone={GROUP[s.category].tone}>{GROUP[s.category].label}</Badge></span>
                        {project ? (
                          <Select aria-label={`Status for ${s.name}`} className="w-44 max-sm:w-full" value={statusMap[s.name.toLowerCase()] ?? ""} onChange={(e) => setStatusMap({ ...statusMap, [s.name.toLowerCase()]: e.target.value })}>
                            <option value="">{project.statuses.some((x) => x.name.toLowerCase() === s.name.toLowerCase()) ? "Same name" : "Add as new"}</option>
                            {project.statuses.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                          </Select>
                        ) : <span className="text-[12px] text-muted">New status</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}

        {((step === 3 && tp) || (step === 1 && p && !tp)) && p && (
          <div>
            <p className="mb-2 text-sm text-muted">
              {count} {noun} will come in{p.kind === "tasks" && p.alreadyImported ? `; ${p.alreadyImported} are already here and are skipped` : ""}{p.kind === "contacts" && p.alreadyThere ? `; ${p.alreadyThere} are already in Contacts` : ""}{p.kind !== "tasks" && p.skipped ? `; ${p.skipped} are left out (no date, cancelled or no email)` : ""}.
            </p>
            {p.kind === "workspace" && p.parts && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                {Object.entries(p.parts).map(([k, v]) => <div key={k} className="rounded-xl border border-line bg-fill/40 px-3 py-2"><div className="text-[18px] font-semibold tabular-nums">{v}</div><div className="text-[12px] capitalize text-muted">{k}</div></div>)}
              </div>
            )}
            {(tp?.rows ?? (p.kind !== "tasks" ? p.rows : undefined))?.length ? (
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full min-w-[520px] text-left text-[13px]" aria-label="Import preview">
                  <thead className="bg-fill text-muted">
                    <tr>{previewColumns(p).map((c) => <th key={c} className="px-3 py-2 font-medium">{c}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {previewRows(p).map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={"max-w-[240px] truncate px-3 py-2 " + (j ? "text-muted" : "")}>{v}</td>)}</tr>)}
                  </tbody>
                </table>
              </div>
            ) : null}
            {tp && tp.leftToday < count && <p className="mt-2 text-xs text-subtle">{tp.leftToday} can come in today; the rest carry on tomorrow with the same file.</p>}
          </div>
        )}

        {step === steps.length - 1 && (
          <div className="flex flex-col items-center gap-3 py-4 text-center" role="status" aria-live="polite" data-testid="move-progress">
            <ProgressRing value={running && !progress ? null : pct} label="Import progress" />
            {running && <p className="text-sm text-muted">Bringing {noun} in{progress ? `: ${progress.move.done} of ${progress.move.total}` : ""}. You can keep working.</p>}
            {!running && progress && <ImportSummary move={progress.move} stopped={progress.stopped} onRetry={start} noun={noun} />}
            {runError && <p className="text-sm text-bad" role="alert">{runError}</p>}
          </div>
        )}

        {step < steps.length - 1 && p && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
            <Button size="sm" variant="ghost" onClick={back} disabled={step === 0}><IconArrowLeft className="h-4 w-4" aria-hidden />Back</Button>
            {step < steps.length - 2
              ? <Button size="sm" onClick={next} disabled={!!tp && !mapping?.title}>Next<IconArrowRight className="h-4 w-4" aria-hidden /></Button>
              : <Button size="sm" onClick={() => void start()} disabled={!count} data-testid="move-run"><IconUpload className="h-4 w-4" aria-hidden />{count ? `Import ${count} ${noun}` : "Everything is already here"}</Button>}
          </div>
        )}
      </div>
    </div>
  );
}

function previewColumns(p: Preview): string[] {
  if (p.kind === "tasks") return ["Title", "Status", "Assignee", "Due", "Parent", "Labels"];
  if (p.kind === "contacts") return ["Name", "Email", "Phone", "Company"];
  if (p.kind === "calendar") return ["Event", "Starts", "Minutes", "Repeats"];
  return ["Page", "Words"];
}
function previewRows(p: Preview): string[][] {
  if (p.kind === "tasks") return p.rows.map((r) => [r.title, r.status ?? (r.group ? GROUP[r.group].label : ""), r.assignees.join(", "), r.due ?? "", r.parent ?? "", r.labels.join(", ")]);
  const rows = (p.rows ?? []) as Record<string, string | number | null>[];
  if (p.kind === "contacts") return rows.map((r) => [String(r.name || r.email), String(r.email), String(r.phone ?? ""), String(r.company ?? "")]);
  if (p.kind === "calendar") return rows.map((r) => [String(r.title), new Date(String(r.startsAt)).toLocaleString(), String(r.durationMin), r.recurrence ? "Weekly" : ""]);
  return rows.map((r) => [String(r.title), String(r.words)]);
}

function ImportSummary({ move, stopped, onRetry, noun }: { move: Move; stopped: string | null; onRetry: () => void; noun: string }) {
  const [confirm, setConfirm] = useState(false);
  const [undone, setUndone] = useState(false);
  const undo = useUndo(move.id, () => { setConfirm(false); setUndone(true); });
  if (move.status === "undone" || undone) return <p className="text-sm font-medium">Undone. Everything this import made is gone.</p>;
  return (
    <div className="space-y-2">
      <p className="text-[15px] font-semibold">{move.status === "done" ? `Done: ${move.created} ${noun} brought in` : `${move.done} of ${move.total} in so far`}</p>
      {move.counts.comments ? <p className="text-sm text-muted">{move.counts.comments} comments came with them.</p> : null}
      {stopped === "daily_cap" && <p className="text-sm text-muted">A workspace can bring in 2,000 tasks a day. Upload the same file tomorrow and it carries on.</p>}
      {stopped === "write_budget" && <p className="text-sm text-muted">Big imports are paused for today. Upload the same file tomorrow and it carries on.</p>}
      <div className="flex flex-wrap justify-center gap-2 pt-1">
        {move.status !== "done" && <Button size="sm" variant="outline" onClick={onRetry}>Carry on</Button>}
        {move.projectId && <Link to={`/app/tasks?project=${move.projectId}&view=list`} className="inline-flex h-8 items-center gap-1 rounded-lg px-3 text-[13px] font-medium text-brand hover:bg-brand-soft">Open project<IconArrowRight className="h-4 w-4" aria-hidden /></Link>}
        {move.canUndo && <Button size="sm" variant="danger" onClick={() => setConfirm(true)} data-testid="move-undo"><IconUndo className="h-4 w-4" aria-hidden />Undo this import</Button>}
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => undo.mutate()} busy={undo.isPending} title="Undo this import?"
        description={`This removes the ${move.created} ${noun} it made, with their comments, including any changes made to them since. Nothing else is touched.`} confirmLabel="Undo import" />
    </div>
  );
}

function useUndo(id: string, done: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ removed: number }>(`/data-moves/${id}/undo`, {}),
    onSuccess: (r) => { toast.success(`Removed ${r.removed} items.`); qc.invalidateQueries(); done(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not undo. Try again."),
  });
}

// ------------------------------------------------------------------ export

const INCLUDED = [
  { label: "Tasks", fmt: "JSON and CSV", icon: <IconTasks /> },
  { label: "Docs", fmt: "Markdown", icon: <IconDocs /> },
  { label: "Calendar", fmt: ".ics", icon: <IconCalendar /> },
  { label: "Contacts", fmt: "vCard and CSV", icon: <IconContacts /> },
  { label: "Chat", fmt: "JSON and CSV", icon: <IconChat /> },
  { label: "Mail", fmt: "mbox", icon: <IconMail /> },
];

const plural = (n: number | undefined, word: string) => `${n ?? 0} ${word}${n === 1 ? "" : "s"}`;

function ExportCard() {
  const qc = useQueryClient();
  const exp = useMutation({
    mutationFn: () => api.post<Move & { downloadPath: string }>("/data-moves/exports", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["data-moves"] }),
  });
  const r = exp.data;
  const link = r ? new URL(r.downloadPath, window.location.origin).toString() : "";
  return (
    <Section id="move-out" title="Export everything" description="One ZIP with all of your workspace in open formats any tool can read. Passwords, keys and private links are never in it.">
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
        {INCLUDED.map((i) => (
          <li key={i.label} className="flex items-center gap-2.5 rounded-xl border border-line bg-fill/30 px-3 py-2">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface text-[#0071E3] shadow-[0_0_0_0.5px_rgb(0_0_0/0.06)] [&_svg]:h-4 [&_svg]:w-4" aria-hidden>{i.icon}</span>
            <span className="min-w-0"><span className="block truncate text-[13px] font-medium">{i.label}</span><span className="block text-[11.5px] text-muted">{i.fmt}</span></span>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-col items-start gap-3 sm:flex-row sm:items-center" data-testid="move-export">
        {!r && <Button onClick={() => exp.mutate()} loading={exp.isPending} data-testid="move-export-start"><IconDownload className="h-4 w-4" aria-hidden />Export workspace</Button>}
        {exp.isPending && <span className="flex items-center gap-2 text-sm text-muted"><ProgressRing value={null} size={28} label="Preparing the export" />Counting your data</span>}
        {r && (
          <div className="flex w-full flex-col gap-3 rounded-xl border border-ok/30 bg-ok-soft/40 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-ok text-white [&_svg]:h-5 [&_svg]:w-5" aria-hidden><IconCheck /></span>
              <div>
                <p className="text-[14px] font-semibold">Your export is ready</p>
                <p className="text-[12.5px] text-muted">{plural(r.counts.tasks, "task")}, {plural(r.counts.docs, "doc")}, {plural(r.counts.meetings, "meeting")}, {plural(r.counts.contacts, "contact")}. The link works until {r.expiresAt ? new Date(r.expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "this time tomorrow"}.</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <a href={r.downloadPath} download className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-lg bg-brand px-4 text-sm font-medium text-brand-fg hover:bg-brand/90 max-sm:min-h-11" data-testid="move-download"><IconDownload className="h-4 w-4" aria-hidden />Download ZIP</a>
              <CopyButton value={link} label="Copy link" />
            </div>
          </div>
        )}
      </div>
      {exp.error instanceof ApiError && <p className="mt-2 text-sm text-bad" role="alert">{exp.error.message}</p>}
      <p className="mt-3 text-[12.5px] text-muted">To keep another tool in sync after you move, use webhooks or the API in <Link to="/app/settings/developers" className="font-medium text-brand hover:underline">Developers</Link>.</p>
    </Section>
  );
}

// ------------------------------------------------------------------ history

const KIND_LABEL: Record<string, string> = { tasks: "Tasks", calendar: "Calendar", contacts: "Contacts", docs: "Docs", workspace: "Workspace" };
const STATUS: Record<Move["status"], { label: string; tone: "neutral" | "brand" | "ok" | "bad" }> = {
  running: { label: "Running", tone: "brand" }, stopped: { label: "Paused", tone: "neutral" }, done: { label: "Done", tone: "ok" }, undone: { label: "Undone", tone: "neutral" },
  failed: { label: "Failed", tone: "bad" }, ready: { label: "Link ready", tone: "ok" }, expired: { label: "Link expired", tone: "neutral" },
};

function HistoryRow({ m }: { m: Move }) {
  const [confirm, setConfirm] = useState(false);
  const undo = useUndo(m.id, () => setConfirm(false));
  const [kind, src] = m.source.split(":");
  const label = m.kind === "export" ? "Workspace export" : `${KIND_LABEL[kind] ?? "Import"}${src && src !== kind ? ` from ${SOURCES.find((s) => s.id === src)?.label ?? (src === "multies" ? "an export" : src.toUpperCase())}` : ""}`;
  const st = STATUS[m.status];
  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2.5" data-testid="move-history-row">
      <span className={"grid h-8 w-8 shrink-0 place-items-center rounded-[9px] [&_svg]:h-4 [&_svg]:w-4 " + (m.kind === "export" ? "bg-brand-soft text-brand" : "bg-fill text-muted")} aria-hidden>{m.kind === "export" ? <IconDownload /> : <IconUpload />}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px] font-medium">{label}{m.fileName ? <span className="font-normal text-muted"> · {m.fileName}</span> : null}</p>
        <p className="text-[12px] text-muted">{timeAgo(m.createdAt)}{m.by ? ` by ${m.by}` : ""}{m.kind === "import" ? ` · ${plural(m.created, "item")} made${m.total && m.done < m.total ? `, ${m.done} of ${m.total} read` : ""}` : ` · ${plural(m.total, "item")}`}</p>
      </div>
      <Badge tone={st.tone}>{st.label}</Badge>
      {m.canUndo && <Button size="sm" variant="ghost" onClick={() => setConfirm(true)} aria-label={`Undo ${label}`}><IconUndo className="h-4 w-4" aria-hidden />Undo</Button>}
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => undo.mutate()} busy={undo.isPending} title="Undo this import?"
        description={`This removes the ${m.created} items it made, including any changes made to them since. Nothing else is touched.`} confirmLabel="Undo import" />
    </li>
  );
}

function HistoryCard() {
  const q = useQuery({ queryKey: ["data-moves"], queryFn: () => api.get<{ items: Move[] }>("/data-moves"),
    refetchInterval: (x) => (x.state.data?.items.some((m) => m.status === "running") ? 4000 : false) });
  const items = useMemo(() => q.data?.items ?? [], [q.data]);
  return (
    <Section id="move-history" title="History" description="Every import and export in this workspace. Undo removes exactly what an import made.">
      {q.isPending ? <div className="space-y-2"><Skeleton className="h-12" /><Skeleton className="h-12" /></div>
        : items.length ? <ul className="divide-y divide-line rounded-xl border border-line" aria-label="Import and export history">{items.map((m) => <HistoryRow key={m.id} m={m} />)}</ul>
        : <EmptyState icon={<IconHistory />} title="Nothing moved yet" body="Imports and exports show here, each with its progress and an Undo for imports." className="py-8" />}
    </Section>
  );
}
