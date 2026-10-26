/**
 * Custom fields in the app: show and edit a value, the field list for a project, and the
 * filter row for the list view. Values follow the API: currency is AUD, dates are YYYY-MM-DD.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Check, ExternalLink, GripVertical, Plus, Trash2, X } from "lucide-react";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Input, Select } from "@/web/components/ui/input";
import { cn } from "@/web/lib/cn";
import type { AssigneeOption, CustomField, FieldType, FieldValue } from "./data";
import { ComputedCell, ComputedEditor, describeComputed, isComputed, type ComputedConfig } from "./computed-fields";

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: "Text", number: "Number", currency: "Currency (AUD)", date: "Date", select: "Single select", multiselect: "Multi select", person: "Person", checkbox: "Checkbox", url: "Link", formula: "Formula", rollup: "Rollup",
};
const aud = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
const num = new Intl.NumberFormat("en-AU", { maximumFractionDigits: 4 });
const dateFmt = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function formatValue(field: CustomField, v: FieldValue | undefined, people: AssigneeOption[] = []): string {
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return "";
  switch (field.type) {
    case "currency": return aud.format(Number(v));
    case "number": return num.format(Number(v));
    case "date": return dateFmt.format(new Date(`${String(v)}T00:00:00Z`));
    case "checkbox": return v ? "Yes" : "";
    case "select": return field.options.find((o) => o.id === v)?.label ?? "";
    case "multiselect": return (v as string[]).map((id) => field.options.find((o) => o.id === id)?.label).filter(Boolean).join(", ");
    case "person": return people.find((p) => p.id === v)?.name ?? "Former member";
    case "url": try { return new URL(String(v)).host; } catch { return String(v); }
    default: return String(v);
  }
}

/** A compact read-only value for list cells and board cards. */
export function FieldCell({ field, value, people, error, fields }: { field: CustomField; value: FieldValue | undefined; people?: AssigneeOption[]; error?: string; fields?: CustomField[] }) {
  if (isComputed(field)) return <ComputedCell field={field} value={value} error={error} fields={fields} />;
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return <span className="text-subtle" aria-label="Empty">-</span>;
  if (field.type === "select" || field.type === "multiselect") {
    const ids = Array.isArray(value) ? value : [String(value)];
    return (
      <span className="inline-flex flex-wrap gap-1">
        {ids.map((id) => { const o = field.options.find((x) => x.id === id); return o ? <span key={id} className="rounded px-1.5 py-px text-[11.5px] font-medium" style={{ background: `${o.color}26`, color: o.color }}>{o.label}</span> : null; })}
      </span>
    );
  }
  if (field.type === "checkbox") return <span className="inline-flex text-ok" role="img" aria-label="Yes"><Check className="h-4 w-4" aria-hidden /></span>;
  if (field.type === "url") return <a href={String(value)} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 text-brand-hover hover:underline">{formatValue(field, value)}<ExternalLink className="h-3 w-3" /></a>;
  return <span className={cn("whitespace-nowrap", (field.type === "currency" || field.type === "number") && "tabular-nums")}>{formatValue(field, value, people)}</span>;
}

/** An editable value on the task panel. Saves on change (selects, dates, checkboxes) or on blur (text). */
export function FieldInput({ field, value, people, onSave }: { field: CustomField; value: FieldValue | undefined; people: AssigneeOption[]; onSave: (v: FieldValue) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const label = field.name;
  const cls = "h-8 text-[13px]";
  if (isComputed(field)) return <span aria-label={label}><ComputedCell field={field} value={value} /></span>;
  switch (field.type) {
    case "checkbox":
      return <input type="checkbox" aria-label={label} checked={value === true} onChange={(e) => onSave(e.target.checked)} className="h-4 w-4 accent-[var(--color-brand)]" />;
    case "select":
      return (
        <Select aria-label={label} value={(value as string) ?? ""} onChange={(e) => onSave(e.target.value || null)} className={cls}>
          <option value="">Not set</option>
          {field.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </Select>
      );
    case "multiselect": {
      const list = (value as string[] | undefined) ?? [];
      return (
        <div className="flex flex-wrap gap-1" role="group" aria-label={label}>
          {field.options.map((o) => {
            const on = list.includes(o.id);
            return (
              <button key={o.id} type="button" aria-pressed={on} onClick={() => onSave(on ? list.filter((x) => x !== o.id) : [...list, o.id])}
                className={cn("rounded px-1.5 py-0.5 text-[12px] font-medium ring-1 ring-inset", on ? "" : "opacity-50 ring-line")} style={on ? { background: `${o.color}26`, color: o.color } : undefined}>
                {o.label}
              </button>
            );
          })}
          {!field.options.length && <span className="text-[12px] text-subtle">No options yet</span>}
        </div>
      );
    }
    case "person":
      return (
        <Select aria-label={label} value={(value as string) ?? ""} onChange={(e) => onSave(e.target.value || null)} className={cls}>
          <option value="">Nobody</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.type === "agent" ? " (agent)" : ""}</option>)}
        </Select>
      );
    case "date":
      return <Input type="date" aria-label={label} value={(value as string) ?? ""} onChange={(e) => onSave(e.target.value || null)} className={cls} />;
    default: {
      const shown = draft ?? (value === null || value === undefined ? "" : String(value));
      const numeric = field.type === "number" || field.type === "currency";
      return (
        <div className="relative">
          {field.type === "currency" && <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[12px] text-subtle">A$</span>}
          <Input aria-label={label} inputMode={numeric ? "decimal" : field.type === "url" ? "url" : undefined} value={shown}
            placeholder={field.type === "url" ? "https://" : numeric ? "0" : ""}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            onBlur={() => {
              if (draft === null) return;
              const v = draft.trim();
              setDraft(null);
              const next: FieldValue = v === "" ? null : numeric ? Number(v.replace(/[$,\s]|A\$/g, "")) : v;
              if (next !== (value ?? null)) onSave(next);
            }}
            className={cn(cls, field.type === "currency" && "pl-7")} />
        </div>
      );
    }
  }
}

/** Add, rename, reorder and delete a project's fields, and edit select options. */
export function FieldsDialog({ projectId, fields, open, onClose }: { projectId: string; fields: CustomField[]; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const [options, setOptions] = useState("");
  const [config, setConfig] = useState<ComputedConfig>({});
  const [busy, setBusy] = useState(false);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["fields", projectId] }); void qc.invalidateQueries({ queryKey: ["tasks"] }); void qc.invalidateQueries({ queryKey: ["task"] }); };
  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api.post("/fields", { projectId, name, type, ...(type === "select" || type === "multiselect" ? { options: options.split(",").map((x) => x.trim()).filter(Boolean).map((label) => ({ label })) } : {}),
        ...(type === "formula" ? { config: { expression: config.expression ?? "" } } : type === "rollup" ? { config: { source: config.source ?? "subtasks", fn: config.fn ?? "sum", field: config.field ?? "points" } } : {}) });
      setName(""); setOptions(""); setConfig({}); refresh();
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  const patch = async (id: string, body: Record<string, unknown>) => { try { await api.patch(`/fields/${id}`, body); refresh(); } catch (e) { showError(e as Error); } };
  const remove = async (f: CustomField) => {
    if (!window.confirm(`Delete the field "${f.name}" and its values on every task?`)) return;
    try { await api.del(`/fields/${f.id}`); refresh(); } catch (e) { showError(e as Error); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Custom fields" description="Fields show on every task in this project, as list columns and in filters.">
      <ul className="space-y-2" aria-label="Fields">
        {fields.map((f, i) => (
          <li key={f.id} className="rounded-lg border border-line p-2.5">
            <div className="flex items-center gap-2">
              <GripVertical className="h-4 w-4 text-subtle" aria-hidden />
              <Input aria-label={`Name of ${f.name}`} defaultValue={f.name} onBlur={(e) => e.target.value.trim() && e.target.value !== f.name && patch(f.id, { name: e.target.value })} className="h-8 flex-1 text-[13px]" />
              <span className="whitespace-nowrap text-[12px] text-subtle" title={isComputed(f) ? describeComputed(f, fields) : undefined}>{FIELD_TYPE_LABEL[f.type]}</span>
              <Button variant="ghost" size="icon" aria-label={`Move ${f.name} up`} disabled={i === 0} onClick={() => patch(f.id, { position: fields[i - 1].position - 1 })}><ArrowUp className="h-4 w-4" aria-hidden /></Button>
              <Button variant="ghost" size="icon" aria-label={`Delete ${f.name}`} onClick={() => remove(f)}><Trash2 className="h-4 w-4" /></Button>
            </div>
            {(f.type === "select" || f.type === "multiselect") && (
              <Input aria-label={`Options for ${f.name}`} defaultValue={f.options.map((o) => o.label).join(", ")} placeholder="Options, separated by commas"
                onBlur={(e) => {
                  const labels = e.target.value.split(",").map((x) => x.trim()).filter(Boolean);
                  if (labels.join(",") === f.options.map((o) => o.label).join(",")) return;
                  patch(f.id, { options: labels.map((label) => ({ id: f.options.find((o) => o.label === label)?.id, label })) });
                }} className="mt-2 h-8 text-[12.5px]" />
            )}
            {isComputed(f) && <ExistingComputed field={f} projectId={projectId} fields={fields} onSave={(c) => patch(f.id, { config: c })} />}
          </li>
        ))}
        {!fields.length && <li className="text-[13px] text-muted">No custom fields yet. Add Budget, Client or Stage below.</li>}
      </ul>
      <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]">
        <Input aria-label="New field name" placeholder="Field name, e.g. Budget" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} className="h-9 text-[13px]" />
        <Select aria-label="New field type" value={type} onChange={(e) => setType(e.target.value as FieldType)} className="h-9 text-[13px]">
          {(Object.keys(FIELD_TYPE_LABEL) as FieldType[]).map((t) => <option key={t} value={t}>{FIELD_TYPE_LABEL[t]}</option>)}
        </Select>
        {(type === "formula" || type === "rollup") && (
          <ComputedEditor type={type} projectId={projectId} fields={fields} value={config} onChange={setConfig} />
        )}
        {(type === "select" || type === "multiselect") && (
          <Input aria-label="New field options" placeholder="Options, separated by commas" value={options} onChange={(e) => setOptions(e.target.value)} className="h-9 text-[13px] sm:col-span-2" />
        )}
        <Button onClick={add} disabled={busy || !name.trim()} className="sm:col-span-2"><Plus className="h-4 w-4" />Add field</Button>
      </div>
    </Dialog>
  );
}

/** A formula or rollup in the field list: edit its settings, saved with a Save button. */
function ExistingComputed({ field, projectId, fields, onSave }: { field: CustomField; projectId: string; fields: CustomField[]; onSave: (c: ComputedConfig) => void }) {
  const [draft, setDraft] = useState<ComputedConfig>(field.config ?? {});
  const changed = JSON.stringify(draft) !== JSON.stringify(field.config ?? {});
  return (
    <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
      <ComputedEditor type={field.type as "formula" | "rollup"} projectId={projectId} fields={fields.filter((x) => x.id !== field.id)} value={draft} onChange={setDraft} idPrefix={field.name} />
      {changed && <Button size="sm" className="sm:col-span-2" onClick={() => onSave(draft)}>Save {field.name}</Button>}
    </div>
  );
}

/** The ops a filter offers for a field type, with plain names. */
export function opsFor(t: FieldType): { id: string; label: string }[] {
  if (t === "number" || t === "currency") return [{ id: "eq", label: "is" }, { id: "gt", label: "more than" }, { id: "lt", label: "less than" }, { id: "empty", label: "is empty" }, { id: "notempty", label: "is set" }];
  if (t === "date") return [{ id: "eq", label: "is" }, { id: "lt", label: "before" }, { id: "gt", label: "after" }, { id: "empty", label: "is empty" }, { id: "notempty", label: "is set" }];
  if (t === "checkbox") return [{ id: "eq", label: "is" }];
  if (t === "text" || t === "url") return [{ id: "contains", label: "contains" }, { id: "empty", label: "is empty" }, { id: "notempty", label: "is set" }];
  return [{ id: "eq", label: "is" }, { id: "ne", label: "is not" }, { id: "empty", label: "is empty" }, { id: "notempty", label: "is set" }];
}

/** Parses the `field.<id>` URL value back into op and value. */
export function splitFilter(raw: string): { op: string; value: string } {
  const i = raw.indexOf(":");
  const head = i > 0 ? raw.slice(0, i) : raw;
  if (["eq", "ne", "gt", "gte", "lt", "lte", "contains"].includes(head)) return { op: head, value: raw.slice(i + 1) };
  if (head === "empty" || head === "notempty") return { op: head, value: "" };
  return { op: "eq", value: raw };
}

/** "Add filter" on a custom field: pick a field, an op and a value. */
export function FieldFilterPicker({ fields, people, onAdd }: { fields: CustomField[]; people: AssigneeOption[]; onAdd: (fieldId: string, raw: string) => void }) {
  const [open, setOpen] = useState(false);
  const [fieldId, setFieldId] = useState("");
  const [op, setOp] = useState("eq");
  const [value, setValue] = useState("");
  const field = fields.find((f) => f.id === fieldId);
  if (!fields.length) return null;
  if (!open) return <Button variant="ghost" size="sm" onClick={() => { setOpen(true); setFieldId(fields[0].id); setOp(opsFor(fields[0].type)[0].id); }}><Plus className="h-3.5 w-3.5" />Field filter</Button>;
  const apply = () => {
    if (!field) return;
    if (op === "empty" || op === "notempty") onAdd(field.id, op);
    else if (value !== "") onAdd(field.id, `${op}:${value}`);
    else return;
    setOpen(false); setValue("");
  };
  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface p-1" role="group" aria-label="Field filter">
      <Select aria-label="Filter field" value={fieldId} onChange={(e) => { setFieldId(e.target.value); const f = fields.find((x) => x.id === e.target.value); if (f) setOp(opsFor(f.type)[0].id); setValue(""); }} className="h-7 w-auto! text-[12.5px]">
        {fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
      </Select>
      {field && (
        <Select aria-label="Filter condition" value={op} onChange={(e) => setOp(e.target.value)} className="h-7 w-auto! text-[12.5px]">
          {opsFor(field.type).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </Select>
      )}
      {field && op !== "empty" && op !== "notempty" && (
        field.type === "select" || field.type === "multiselect" ? (
          <Select aria-label="Filter value" value={value} onChange={(e) => setValue(e.target.value)} className="h-7 w-auto! text-[12.5px]">
            <option value="">Choose</option>
            {field.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </Select>
        ) : field.type === "checkbox" ? (
          <Select aria-label="Filter value" value={value} onChange={(e) => setValue(e.target.value)} className="h-7 w-auto! text-[12.5px]">
            <option value="">Choose</option><option value="true">ticked</option><option value="false">not ticked</option>
          </Select>
        ) : field.type === "person" ? (
          <Select aria-label="Filter value" value={value} onChange={(e) => setValue(e.target.value)} className="h-7 w-auto! text-[12.5px]">
            <option value="">Choose</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        ) : (
          <Input aria-label="Filter value" type={field.type === "date" ? "date" : "text"} inputMode={field.type === "number" || field.type === "currency" ? "decimal" : undefined}
            value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && apply()} className="h-7 w-28! text-[12.5px]" />
        )
      )}
      <Button size="sm" onClick={apply}>Apply</Button>
      <Button variant="ghost" size="icon" aria-label="Cancel" onClick={() => setOpen(false)}><X className="h-3.5 w-3.5" /></Button>
    </div>
  );
}

/** The chip text for an active field filter. */
export function describeFilter(field: CustomField | undefined, raw: string, people: AssigneeOption[]) {
  if (!field) return raw;
  const { op, value } = splitFilter(raw);
  const label = opsFor(field.type).find((o) => o.id === op)?.label ?? op;
  if (op === "empty" || op === "notempty") return `${field.name} ${label}`;
  const shown = field.type === "checkbox" ? (value === "true" ? "ticked" : "not ticked")
    : field.type === "select" || field.type === "multiselect" ? (field.options.find((o) => o.id === value)?.label ?? value)
      : field.type === "person" ? (people.find((p) => p.id === value)?.name ?? value)
        : field.type === "currency" ? aud.format(Number(value)) : value;
  return `${field.name} ${label} ${shown}`;
}
