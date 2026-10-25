/**
 * R24.1 Formula and rollup fields in the app: the editor inside "Custom fields" (expression box with
 * a live preview against the first task, or source, field and function pickers for a rollup), the
 * read only cell with the expression on hover, and the project rollups strip in the Tasks header.
 * Everything here is computed on read by the server; nothing is stored per task.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, FunctionSquare, Sigma } from "lucide-react";
import { api } from "@/web/lib/api";
import { Input, Select } from "@/web/components/ui/input";
import { cn } from "@/web/lib/cn";
import type { CustomField, FieldValue } from "./data";

export type RollupSource = "subtasks" | "epic_children" | "project";
export type RollupFn = "sum" | "count" | "count_done" | "average" | "min" | "max" | "percent_done";
export interface ComputedConfig { expression?: string; source?: RollupSource; field?: string | null; fn?: RollupFn }

export const SOURCE_LABEL: Record<RollupSource, string> = { subtasks: "Subtasks", epic_children: "Epic items and their subtasks", project: "Whole project (header)" };
export const FN_LABEL: Record<RollupFn, string> = { sum: "Sum", count: "Count", count_done: "Count done", average: "Average", min: "Smallest", max: "Largest", percent_done: "Percent done" };
const NEEDS_FIELD: Record<RollupFn, boolean> = { sum: true, average: true, min: true, max: true, count: false, count_done: false, percent_done: false };

export const isComputed = (f: Pick<CustomField, "type">) => f.type === "formula" || f.type === "rollup";
export const isProjectRollup = (f: Pick<CustomField, "type" | "config">) => f.type === "rollup" && f.config?.source === "project";
/** Fields that show as task columns and in the task panel (project rollups show in the header). */
export const taskFields = (fields: CustomField[]) => fields.filter((f) => !isProjectRollup(f));

const num = new Intl.NumberFormat("en-AU", { maximumFractionDigits: 4 });
const aud = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
export function formatComputed(f: CustomField, v: FieldValue | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "number") return f.type === "rollup" && f.config?.fn === "percent_done" ? `${v}%` : num.format(v);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

/** What hovering a computed cell says: the expression, or what the rollup adds up. */
export function describeComputed(f: CustomField, fields: CustomField[] = []): string {
  const c = f.config ?? {};
  if (f.type === "formula") return `= ${c.expression ?? ""}`;
  const of = c.field === "points" ? "Points" : fields.find((x) => x.id === c.field)?.name ?? "";
  return `${FN_LABEL[c.fn ?? "sum"]}${NEEDS_FIELD[c.fn ?? "sum"] && of ? ` of ${of}` : ""} over ${SOURCE_LABEL[c.source ?? "subtasks"].toLowerCase()}`;
}

/** The read only value of a formula or rollup, in list cells, the table and the task panel. */
export function ComputedCell({ field, value, error, fields }: { field: CustomField; value: FieldValue | undefined; error?: string; fields?: CustomField[] }) {
  const tip = error ? `${describeComputed(field, fields)}\n${error}` : describeComputed(field, fields);
  if (value === "#ERROR") {
    return <span title={tip} className="inline-flex items-center gap-1 whitespace-nowrap text-[12.5px] font-medium text-bad" data-computed="error"><AlertCircle className="h-3.5 w-3.5" aria-hidden />#ERROR</span>;
  }
  const shown = formatComputed(field, value);
  if (!shown) return <span title={tip} className="text-subtle" aria-label="Empty">-</span>;
  return <span title={tip} className={cn("whitespace-nowrap", typeof value === "number" && "tabular-nums")} data-computed={field.type}>{shown}</span>;
}

/** Live preview of a formula against the project's first task (nothing saved). */
function Preview({ projectId, expression }: { projectId: string; expression: string }) {
  const [debounced, setDebounced] = useState(expression);
  useEffect(() => { const t = setTimeout(() => setDebounced(expression), 250); return () => clearTimeout(t); }, [expression]);
  const q = useQuery({
    queryKey: ["formula-preview", projectId, debounced],
    enabled: debounced.trim().length > 0,
    queryFn: () => api.get<{ value: FieldValue; error?: string; task: { title: string } | null }>(`/computed/preview?projectId=${encodeURIComponent(projectId)}&expression=${encodeURIComponent(debounced)}`),
  });
  if (!debounced.trim()) return <p className="text-[12px] text-subtle">Type a formula, for example {"{Budget} * 1.1"} or points * 2.</p>;
  if (q.isPending) return <p className="text-[12px] text-subtle">Checking...</p>;
  if (q.isError) return <p role="alert" className="text-[12px] text-bad">{(q.error as Error).message}</p>;
  const d = q.data!;
  if (d.error) return <p role="alert" className="flex items-center gap-1 text-[12px] text-bad" data-testid="formula-error"><AlertCircle className="h-3.5 w-3.5" aria-hidden />{d.error}</p>;
  return (
    <p className="text-[12px] text-muted" data-testid="formula-preview">
      {d.task ? <>On &ldquo;{d.task.title}&rdquo;: <span className="font-medium text-fg">{d.value === null || d.value === "" ? "empty" : String(d.value)}</span></> : "Looks right. Add a task to see a value."}
    </p>
  );
}

/** Settings for a new or existing formula or rollup field. */
export function ComputedEditor({ type, projectId, fields, value, onChange, idPrefix = "New field" }: {
  type: "formula" | "rollup"; projectId: string; fields: CustomField[]; value: ComputedConfig; onChange: (c: ComputedConfig) => void; idPrefix?: string;
}) {
  if (type === "formula") {
    return (
      <div className="space-y-1.5 sm:col-span-2">
        <div className="relative">
          <FunctionSquare className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
          <Input aria-label={`${idPrefix} formula`} placeholder="{Budget} * 1.1" value={value.expression ?? ""} maxLength={500}
            onChange={(e) => onChange({ expression: e.target.value })} className="h-9 pl-8 font-mono text-[12.5px]" spellCheck={false} />
        </div>
        <Preview projectId={projectId} expression={value.expression ?? ""} />
        <p className="text-[11.5px] text-subtle">Fields in braces. Built in: points, due, start, created, completed, status, priority, title, assignee. Functions: if, round, min, max, sum, concat, days_between, today, date_add, coalesce and more.</p>
      </div>
    );
  }
  const numeric = fields.filter((f) => f.type === "number" || f.type === "currency" || f.type === "formula");
  const fn = value.fn ?? "sum";
  return (
    <div className="grid gap-2 sm:col-span-2 sm:grid-cols-3">
      <Select aria-label={`${idPrefix} rollup source`} value={value.source ?? "subtasks"} onChange={(e) => onChange({ ...value, source: e.target.value as RollupSource })} className="h-9 text-[13px]">
        {(Object.keys(SOURCE_LABEL) as RollupSource[]).map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
      </Select>
      <Select aria-label={`${idPrefix} rollup function`} value={fn} onChange={(e) => onChange({ ...value, fn: e.target.value as RollupFn })} className="h-9 text-[13px]">
        {(Object.keys(FN_LABEL) as RollupFn[]).map((s) => <option key={s} value={s}>{FN_LABEL[s]}</option>)}
      </Select>
      <Select aria-label={`${idPrefix} rollup field`} value={NEEDS_FIELD[fn] ? value.field ?? "points" : ""} disabled={!NEEDS_FIELD[fn]} onChange={(e) => onChange({ ...value, field: e.target.value })} className="h-9 text-[13px]">
        {!NEEDS_FIELD[fn] && <option value="">Counts tasks</option>}
        <option value="points">Points</option>
        {numeric.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
      </Select>
    </div>
  );
}

interface RollupRow { id: string; name: string; fn: RollupFn; fieldName: string | null; value: number | string | null; error?: string }

/** Project rollups (source: whole project) as small stat chips in the Tasks header. */
export function ProjectRollups({ projectId, fields }: { projectId: string; fields: CustomField[] }) {
  const defs = fields.filter(isProjectRollup);
  const q = useQuery({
    queryKey: ["tasks", "rollups", projectId, defs.map((d) => d.id).join(",")],
    enabled: defs.length > 0,
    queryFn: () => api.get<{ rollups: RollupRow[] }>(`/computed/projects/${encodeURIComponent(projectId)}/rollups`),
  });
  if (!defs.length || !q.data?.rollups.length) return null;
  const currency = (r: RollupRow) => fields.find((f) => f.id === defs.find((d) => d.id === r.id)?.config?.field)?.type === "currency" && r.fn !== "count" && r.fn !== "count_done" && r.fn !== "percent_done";
  return (
    <div className="mb-3 flex flex-wrap gap-2" aria-label="Project rollups">
      {q.data.rollups.map((r) => (
        <div key={r.id} title={r.error ?? `${FN_LABEL[r.fn]}${r.fieldName ? ` of ${r.fieldName}` : ""} over the project's tasks`}
          className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-1.5 shadow-card">
          <Sigma className="h-3.5 w-3.5 text-brand" aria-hidden />
          <span className="text-[12px] text-muted">{r.name}</span>
          <span className={cn("text-[13px] font-semibold tabular-nums", r.error ? "text-bad" : "text-fg")} data-testid={`rollup-${r.name}`}>
            {r.value === null ? "-" : typeof r.value === "number" ? (currency(r) ? aud.format(r.value) : `${num.format(r.value)}${r.fn === "percent_done" ? "%" : ""}`) : r.value}
          </span>
        </div>
      ))}
    </div>
  );
}
