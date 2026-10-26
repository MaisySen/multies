/**
 * R31: the form builder's "Show this question if" and answer rules panel, and the Responses view
 * (table with sort, search, date filter, pages and CSV; a summary per question). The rules
 * themselves live in src/shared/form-logic.ts, shared with the server.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { IconBranch, IconChevronDown, IconChevronRight, IconClose, IconDownload, IconPlus, IconSearch, IconSort } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Input, Select } from "@/web/components/ui/input";
import { Skeleton } from "@/web/components/ui/misc";
import { timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { LOGIC_OP_LABELS, LOGIC_OPS, MAX_ROUTES, VALUELESS_OPS, type FieldLogic, type FieldRules, type FormFieldType, type FormRoute, type LogicCondition, type LogicOp } from "@/shared/form-logic";

export interface BuilderField { id?: string; label: string; type: FormFieldType; required?: boolean; options?: string[]; placeholder?: string; logic?: FieldLogic | null; rules?: FieldRules | null }

const small = "h-8 text-[13px]";

/** How many logic conditions and rules a field has, for the collapsed button. */
export function logicCount(f: BuilderField) {
  return (f.logic?.conditions.length ?? 0) + Object.keys(f.rules ?? {}).length;
}

function NumberRule({ label, value, onChange, min = 0 }: { label: string; value: number | undefined; onChange: (v: number | undefined) => void; min?: number }) {
  return (
    <label className="flex items-center gap-2 text-[12.5px] text-muted">
      <span className="w-28 shrink-0">{label}</span>
      <Input type="number" min={min} value={value ?? ""} aria-label={label} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} className={cn(small, "w-24")} />
    </label>
  );
}

/** The panel under one field in the builder. `earlier` are the questions above it (the only ones a condition may use). */
export function LogicEditor({ field, index, earlier, onChange }: { field: BuilderField; index: number; earlier: BuilderField[]; onChange: (patch: Partial<BuilderField>) => void }) {
  const [open, setOpen] = useState(logicCount(field) > 0);
  const logic = field.logic ?? null;
  const rules = field.rules ?? {};
  const conds = logic?.conditions ?? [];
  const usable = earlier.filter((e) => e.id);
  const setConds = (next: LogicCondition[]) => onChange({ logic: next.length ? { join: logic?.join ?? "all", conditions: next } : null });
  const setRule = (k: keyof FieldRules, v: number | string | undefined) => {
    const next = { ...rules, [k]: v };
    if (v === undefined || v === "") delete next[k];
    onChange({ rules: Object.keys(next).length ? next : null });
  };
  const n = logicCount(field);
  return (
    <div className="mt-2">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} data-testid={`logic-toggle-${index}`}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-muted hover:bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
        {open ? <IconChevronDown className="h-3.5 w-3.5" /> : <IconChevronRight className="h-3.5 w-3.5" />}
        <IconBranch className="h-3.5 w-3.5" />Logic and rules{n ? ` (${n})` : ""}
      </button>
      {open && (
        <div className="mt-2 space-y-3 rounded-lg bg-elevated/60 p-2.5">
          <div>
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[12.5px] font-medium">
              Show this question if
              {conds.length > 1 && (
                <Select aria-label="Match" value={logic?.join ?? "all"} onChange={(e) => onChange({ logic: { join: e.target.value as "all" | "any", conditions: conds } })} className={cn(small, "w-auto")}>
                  <option value="all">all of these are true</option><option value="any">any of these is true</option>
                </Select>
              )}
            </div>
            {!usable.length ? <p className="text-[12px] text-subtle">Add a question above this one to show it only for some answers.</p> : (
              <ul className="space-y-1.5">
                {conds.map((c, ci) => {
                  const src = usable.find((u) => u.id === c.field);
                  const withOptions = src?.type === "select" || src?.type === "multiselect";
                  const ops = LOGIC_OPS.filter((o) => (o === "gt" || o === "lt" ? src?.type === "number" || src?.type === "date" : true));
                  const set = (patch: Partial<LogicCondition>) => setConds(conds.map((x, j) => (j === ci ? { ...x, ...patch } : x)));
                  return (
                    <li key={ci} className="grid grid-cols-[1fr_130px_1fr_auto] items-center gap-1.5" data-testid="logic-condition">
                      <Select aria-label="Question" value={c.field} onChange={(e) => set({ field: e.target.value, value: "" })} className={small}>
                        {usable.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
                      </Select>
                      <Select aria-label="Operator" value={c.op} onChange={(e) => set({ op: e.target.value as LogicOp })} className={small}>
                        {ops.map((o) => <option key={o} value={o}>{LOGIC_OP_LABELS[o]}</option>)}
                      </Select>
                      {VALUELESS_OPS.includes(c.op) ? <span /> : withOptions ? (
                        <Select aria-label="Value" value={c.value ?? ""} onChange={(e) => set({ value: e.target.value })} className={small}>
                          <option value="">Choose</option>{src?.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                        </Select>
                      ) : <Input aria-label="Value" value={c.value ?? ""} type={src?.type === "number" ? "number" : src?.type === "date" ? "date" : "text"} onChange={(e) => set({ value: e.target.value })} className={small} />}
                      <button type="button" onClick={() => setConds(conds.filter((_, j) => j !== ci))} className="p-1 text-subtle hover:text-bad" aria-label="Remove condition"><IconClose className="h-3.5 w-3.5" /></button>
                    </li>
                  );
                })}
              </ul>
            )}
            {usable.length > 0 && conds.length < 10 && (
              <Button size="sm" variant="ghost" className="mt-1" onClick={() => setConds([...conds, { field: usable[usable.length - 1].id!, op: "is", value: "" }])}><IconPlus className="h-3.5 w-3.5" />Add condition</Button>
            )}
            {conds.length > 0 && <p className="mt-1 text-[12px] text-subtle">A hidden question is skipped, so it is never required.</p>}
          </div>
          {field.type !== "select" && field.type !== "date" && (
            <div className="space-y-1.5">
              <div className="text-[12.5px] font-medium">Answer rules</div>
              {(field.type === "text" || field.type === "textarea" || field.type === "phone" || field.type === "email") && <>
                <NumberRule label="Shortest" value={rules.minLength} onChange={(v) => setRule("minLength", v)} />
                <NumberRule label="Longest" value={rules.maxLength} onChange={(v) => setRule("maxLength", v)} />
              </>}
              {field.type === "number" && <>
                <NumberRule label="Lowest" value={rules.min} min={-1e9} onChange={(v) => setRule("min", v)} />
                <NumberRule label="Highest" value={rules.max} min={-1e9} onChange={(v) => setRule("max", v)} />
              </>}
              {field.type === "multiselect" && <>
                <NumberRule label="Pick at least" value={rules.minSelected} onChange={(v) => setRule("minSelected", v)} />
                <NumberRule label="Pick at most" value={rules.maxSelected} onChange={(v) => setRule("maxSelected", v)} />
              </>}
              {(field.type === "text" || field.type === "phone") && <>
                <label className="flex items-center gap-2 text-[12.5px] text-muted"><span className="w-28 shrink-0">Pattern</span>
                  <Input aria-label="Pattern" value={rules.pattern ?? ""} placeholder="[A-Z]{3}[0-9]{4}" onChange={(e) => setRule("pattern", e.target.value || undefined)} className={cn(small, "font-mono")} /></label>
                {rules.pattern && <label className="flex items-center gap-2 text-[12.5px] text-muted"><span className="w-28 shrink-0">If it doesn't match</span>
                  <Input aria-label="Pattern message" value={rules.patternMessage ?? ""} placeholder="Use 3 letters then 4 numbers." onChange={(e) => setRule("patternMessage", e.target.value || undefined)} className={small} /></label>}
              </>}
              {field.type === "email" && <p className="text-[12px] text-subtle">Email answers are always checked for a valid address.</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ routing

/** "When <question> <is> <value>, put the task in <project> and assign <person>." The first rule that matches wins. */
export function RoutingEditor({ fields, routes, onChange, projects, people }: {
  fields: BuilderField[]; routes: FormRoute[]; onChange: (r: FormRoute[]) => void;
  projects: { id: string; name: string }[]; people: { id: string; name: string }[];
}) {
  const usable = fields.filter((f) => f.id);
  const set = (i: number, patch: Partial<FormRoute>) => onChange(routes.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="rounded-lg border border-line px-3 py-2.5" data-testid="form-routing">
      <div className="text-[13px] font-medium">Routing</div>
      <div className="text-[12px] text-muted">Send the task to a project or a person based on an answer. The first rule that matches wins.</div>
      <ul className="mt-2 space-y-2">
        {routes.map((r, i) => {
          const src = usable.find((u) => u.id === r.when.field);
          const choice = src?.type === "select" || src?.type === "multiselect";
          return (
            <li key={i} className="space-y-1.5 rounded-md bg-elevated/60 p-2" data-testid="routing-rule">
              <div className="grid grid-cols-[auto_1fr_120px_1fr_auto] items-center gap-1.5 text-[12.5px]">
                <span className="text-muted">When</span>
                <Select aria-label="Routing question" value={r.when.field} onChange={(e) => set(i, { when: { ...r.when, field: e.target.value, value: "" } })} className={small}>{usable.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}</Select>
                <Select aria-label="Routing operator" value={r.when.op} onChange={(e) => set(i, { when: { ...r.when, op: e.target.value as LogicOp } })} className={small}>{LOGIC_OPS.map((o) => <option key={o} value={o}>{LOGIC_OP_LABELS[o]}</option>)}</Select>
                {VALUELESS_OPS.includes(r.when.op) ? <span /> : choice ? (
                  <Select aria-label="Routing value" value={r.when.value ?? ""} onChange={(e) => set(i, { when: { ...r.when, value: e.target.value } })} className={small}><option value="">Choose</option>{src?.options?.map((o) => <option key={o} value={o}>{o}</option>)}</Select>
                ) : <Input aria-label="Routing value" value={r.when.value ?? ""} onChange={(e) => set(i, { when: { ...r.when, value: e.target.value } })} className={small} />}
                <button type="button" onClick={() => onChange(routes.filter((_, j) => j !== i))} className="p-1 text-subtle hover:text-bad" aria-label="Remove rule"><IconClose className="h-3.5 w-3.5" /></button>
              </div>
              <div className="grid grid-cols-[auto_1fr_auto_1fr] items-center gap-1.5 text-[12.5px]">
                <span className="text-muted">Project</span>
                <Select aria-label="Routing project" value={r.projectId ?? ""} onChange={(e) => set(i, { projectId: e.target.value || null })} className={small}><option value="">Form's default</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
                <span className="text-muted">Assign</span>
                <Select aria-label="Routing assignee" value={r.assigneeId ?? ""} onChange={(e) => set(i, { assigneeId: e.target.value || null })} className={small}><option value="">Form's default</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
              </div>
            </li>
          );
        })}
      </ul>
      {usable.length > 0 && routes.length < MAX_ROUTES && (
        <Button size="sm" variant="ghost" className="mt-1" onClick={() => onChange([...routes, { when: { field: usable[usable.length - 1].id!, op: "is", value: "" }, projectId: null, assigneeId: null }])}><IconPlus className="h-3.5 w-3.5" />Add rule</Button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ results

interface ResponseRow { id: string; answers: Record<string, string>; entityType: string | null; entityId: string | null; createdAt: string }
interface ResponsesPage { fields: { id: string; label: string; type: string }[]; responses: ResponseRow[]; total: number; limit: number; offset: number }
type Question =
  | { id: string; label: string; type: string; kind: "choice"; answered: number; counts: { option: string; count: number }[] }
  | { id: string; label: string; type: string; kind: "number"; answered: number; average: number | null; min: number | null; max: number | null }
  | { id: string; label: string; type: string; kind: "text"; answered: number; latest: { answer: string; at: string }[] };
interface Summary { total: number; firstAt: string | null; lastAt: string | null; capped: boolean; questions: Question[] }

const PAGE = 25;

function qs(p: Record<string, string | number | undefined>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== "") s.set(k, String(v));
  return s.toString();
}

/** The Responses view of one form: a table and a summary, both filtered by the same search and dates. */
export function FormResults({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const [tab, setTab] = useState<"responses" | "summary">("responses");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sort, setSort] = useState<{ by: string; dir: "asc" | "desc" }>({ by: "createdAt", dir: "desc" });
  const [offset, setOffset] = useState(0);
  const filter = { q: search.trim() || undefined, from: from || undefined, to: to || undefined };
  const responses = useQuery({
    queryKey: ["form-responses", id, filter, sort, offset], placeholderData: keepPreviousData, enabled: tab === "responses",
    queryFn: () => api.get<ResponsesPage>(`/forms/${id}/responses?${qs({ ...filter, sort: sort.by, dir: sort.dir, limit: PAGE, offset })}`),
  });
  const summary = useQuery({ queryKey: ["form-summary", id, filter], enabled: tab === "summary", placeholderData: keepPreviousData, queryFn: () => api.get<Summary>(`/forms/${id}/summary?${qs(filter)}`) });
  const toggleSort = (by: string) => { setOffset(0); setSort((s) => ({ by, dir: s.by === by && s.dir === "desc" ? "asc" : "desc" })); };
  const csvHref = `/api/forms/${id}/responses.csv?${qs(filter)}`;
  const data = responses.data;
  const tabCls = (t: string) => cn("rounded-md px-3 py-1 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand", tab === t ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg");
  return (
    <Dialog open onClose={onClose} title={`Responses to ${name}`} className="max-w-5xl">
      <div className="space-y-3" data-testid="form-results">
        <div className="flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label="Results" className="inline-flex rounded-lg bg-elevated p-0.5">
            <button role="tab" aria-selected={tab === "responses"} className={tabCls("responses")} onClick={() => setTab("responses")}>Responses</button>
            <button role="tab" aria-selected={tab === "summary"} className={tabCls("summary")} onClick={() => setTab("summary")}>Summary</button>
          </div>
          <div className="relative ml-auto">
            <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
            <Input aria-label="Search answers" placeholder="Search answers" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} className={cn(small, "w-48 pl-8")} />
          </div>
          <Input aria-label="From" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setOffset(0); }} className={cn(small, "w-36")} />
          <Input aria-label="To" type="date" value={to} onChange={(e) => { setTo(e.target.value); setOffset(0); }} className={cn(small, "w-36")} />
          <a href={csvHref} download className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"><IconDownload className="h-3.5 w-3.5" />CSV</a>
        </div>
        {tab === "responses" ? (
          !data ? <Skeleton className="h-48" /> : !data.total ? <p className="py-8 text-center text-[13px] text-muted">{filter.q || filter.from || filter.to ? "No responses match." : "No responses yet. Share the form's link to start collecting them."}</p> : (
            <>
              <div className="max-h-[55vh] overflow-auto rounded-lg border border-line">
                <table className="w-full text-left text-[13px]" data-testid="responses-table">
                  <thead className="sticky top-0 bg-surface">
                    <tr className="border-b border-line">
                      {[{ id: "createdAt", label: "Submitted" }, ...data.fields].map((f) => (
                        <th key={f.id} scope="col" aria-sort={sort.by === f.id ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className="whitespace-nowrap px-3 py-2 font-medium text-muted">
                          <button type="button" className="inline-flex items-center gap-1 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded" onClick={() => toggleSort(f.id)}>{f.label}<IconSort className={cn("h-3 w-3", sort.by === f.id ? "text-brand" : "text-subtle")} /></button>
                        </th>
                      ))}
                      <th scope="col" className="px-3 py-2"><span className="sr-only">Open</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.responses.map((r) => (
                      <tr key={r.id} className="border-b border-line last:border-0 align-top" data-testid="response-row">
                        <td className="whitespace-nowrap px-3 py-2 text-subtle" title={new Date(r.createdAt).toLocaleString()}>{timeAgo(r.createdAt)}</td>
                        {data.fields.map((f) => <td key={f.id} className="max-w-[260px] px-3 py-2"><span className="line-clamp-3 whitespace-pre-wrap">{r.answers[f.id] ?? ""}</span></td>)}
                        <td className="whitespace-nowrap px-3 py-2">
                          {r.entityType === "task" && r.entityId && <Link className="text-brand-hover hover:underline" to={`/app/tasks?view=list&task=${r.entityId}`}>Task</Link>}
                          {r.entityType === "contact" && r.entityId && <Link className="text-brand-hover hover:underline" to={`/app/contacts/${r.entityId}`}>Contact</Link>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between text-[12.5px] text-muted">
                <span>{data.offset + 1} to {Math.min(data.offset + data.responses.length, data.total)} of {data.total}</span>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Button>
                  <Button size="sm" variant="ghost" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>Next</Button>
                </div>
              </div>
            </>
          )
        ) : <SummaryView s={summary.data} />}
      </div>
    </Dialog>
  );
}

function SummaryView({ s }: { s: Summary | undefined }) {
  const fmt = useMemo(() => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }), []);
  if (!s) return <Skeleton className="h-48" />;
  if (!s.total) return <p className="py-8 text-center text-[13px] text-muted">Nothing to sum up yet.</p>;
  return (
    <div className="max-h-[60vh] space-y-3 overflow-y-auto" data-testid="form-summary">
      <p className="text-[12.5px] text-muted">{s.total} {s.total === 1 ? "response" : "responses"}{s.lastAt ? `, latest ${timeAgo(s.lastAt)}` : ""}{s.capped ? ". Counts use the newest 10,000." : ""}</p>
      {s.questions.map((q) => (
        <section key={q.id} className="rounded-lg border border-line p-3" data-testid="summary-question">
          <div className="flex items-baseline justify-between gap-2"><h3 className="text-[13.5px] font-medium">{q.label}</h3><span className="text-[12px] text-subtle">{q.answered} answered</span></div>
          {q.kind === "choice" && (
            <ul className="mt-2 space-y-1.5">
              {q.counts.map((c) => {
                const pct = q.answered ? Math.round((c.count / q.answered) * 100) : 0;
                return (
                  <li key={c.option} className="grid grid-cols-[minmax(0,160px)_1fr_64px] items-center gap-2 text-[12.5px]">
                    <span className="truncate">{c.option}</span>
                    <div className="h-2 overflow-hidden rounded-full bg-elevated" role="img" aria-label={`${c.option}: ${c.count} (${pct}%)`}><div className="h-full rounded-full bg-brand transition-[width] duration-200 motion-reduce:transition-none" style={{ width: `${pct}%` }} /></div>
                    <span className="text-right tabular-nums text-muted">{c.count} · {pct}%</span>
                  </li>
                );
              })}
            </ul>
          )}
          {q.kind === "number" && (
            <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
              {([["Average", q.average], ["Lowest", q.min], ["Highest", q.max]] as const).map(([k, v]) => (
                <div key={k} className="rounded-md bg-elevated/60 py-2"><dt className="text-[11.5px] text-subtle">{k}</dt><dd className="text-[15px] font-semibold tabular-nums">{v === null ? "-" : fmt.format(v)}</dd></div>
              ))}
            </dl>
          )}
          {q.kind === "text" && (q.latest.length ? (
            <ul className="mt-2 space-y-1 text-[12.5px]">{q.latest.map((l, i) => <li key={i} className="flex gap-2"><span className="min-w-0 flex-1 truncate">{l.answer}</span><span className="shrink-0 text-subtle">{timeAgo(l.at)}</span></li>)}</ul>
          ) : <p className="mt-1 text-[12.5px] text-subtle">No answers yet.</p>)}
        </section>
      ))}
    </div>
  );
}
