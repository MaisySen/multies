/**
 * Tools: the options form pieces every Tools screen shares (the Tools page, batch runs, auto redact).
 * Options of kind "json" are never shown: the screen's own code fills them.
 */
import { Select } from "@/web/components/ui/input";
import { optionShown, type ToolDef, type ToolJob, type ToolOption } from "@/shared/tools";

export const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
export const sizeOf = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : mb(n));

/**
 * R66: where the screen starts differently from the engine's own default, so Run with nothing changed does
 * something useful (Stamp and number pages starts with "Page 1 of 9" numbers instead of nothing at all).
 */
const SCREEN_DEFAULTS: Record<string, Record<string, string>> = { stamp: { page_numbers: "page n of N" } };

/** The defaults a tool's options start from. */
export const defaultsFor = (tool: (Pick<ToolDef, "options"> & { op?: string }) | undefined): Record<string, string> => ({
  ...Object.fromEntries((tool?.options ?? []).map((o) => [o.name, o.default === undefined ? "" : String(o.default)])),
  ...(tool?.op ? SCREEN_DEFAULTS[tool.op] : undefined),
});

/** The options people fill in, with the ones hidden by another choice left out. */
export const visibleOptions = (tool: Pick<ToolDef, "options">, values: Record<string, string>) =>
  tool.options.filter((o) => o.kind !== "json" && optionShown(o, values));

/** What goes to the server: shown options only (a hidden stamp text is not sent). */
export function optionsToSend(tool: Pick<ToolDef, "options">, values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const o of tool.options) if (o.kind !== "json" && optionShown(o, values) && (values[o.name] ?? "").trim() !== "") out[o.name] = values[o.name];
  return out;
}

export function optionProblem(o: ToolOption, v: string): string | null {
  const t = v.trim();
  if (!t) return o.required ? `${o.label} is needed.` : null;
  if (o.maxLen && v.length > o.maxLen) return `${o.label} is too long.`;
  if (o.minLen && v.length < o.minLen) return `${o.label} needs at least ${o.minLen} characters.`;
  if (o.kind === "ranges" && !/^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/.test(t)) return "Use page numbers and ranges, like 1-3, 5.";
  if (o.kind === "int") {
    const n = Number(t);
    if (!Number.isInteger(n) || (o.min !== undefined && n < o.min) || (o.max !== undefined && n > o.max)) return `${o.label} goes from ${o.min} to ${o.max}.`;
  }
  return null;
}

/** The first problem with the options as filled in, or null. */
export const optionsProblem = (tool: Pick<ToolDef, "options"> & { op?: string }, values: Record<string, string>) =>
  visibleOptions(tool, values).map((o) => optionProblem(o, values[o.name] ?? "")).find(Boolean) ?? toolProblem(tool.op, values);

/** R66: checks across options, so Run is never offered for a run that can only fail (and Stamp always has something to add). */
export function toolProblem(op: string | undefined, values: Record<string, string>): string | null {
  if (op !== "stamp") return null;
  const v = (k: string) => (values[k] ?? "").trim();
  if (v("stamp") === "custom" && !v("stamp_text")) return "Type the stamp words.";
  if ((v("stamp") || "none") === "none" && (v("page_numbers") || "none") === "none" && !v("header") && !v("footer")) return "Pick a stamp, page numbers, a header or a footer.";
  return null;
}

export function OptionField({ o, value, onChange, disabled, idPrefix = "tools-opt" }: { o: ToolOption; value: string; onChange: (v: string) => void; disabled: boolean; idPrefix?: string }) {
  const id = `${idPrefix}-${o.name}`;
  const field = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-brand disabled:opacity-60";
  if (o.kind === "json") return null;
  const many = (o.choices?.length ?? 0) > 6;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[13px] font-medium">{o.label}{o.required || o.kind === "choice" || (o.kind === "int" && o.default !== undefined) ? "" : <span className="font-normal text-muted"> (optional)</span>}</label>
      {o.kind === "choice" && o.choices && many ? (
        <Select id={id} data-testid={id} className="sm:w-72" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {o.choices.map((ch) => <option key={ch.value} value={ch.value}>{ch.label}</option>)}
        </Select>
      ) : o.kind === "choice" && o.choices ? (
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={o.label} id={id} data-testid={id}>
          {o.choices.map((ch) => (
            <button key={ch.value} type="button" role="radio" aria-checked={value === ch.value} disabled={disabled} onClick={() => onChange(ch.value)}
              className={`rounded-lg border px-3 py-1.5 text-sm max-sm:min-h-11 ${value === ch.value ? "border-brand bg-brand/5 font-medium" : "border-line hover:bg-hover"}`}>{ch.label}</button>
          ))}
        </div>
      ) : o.kind === "phrases" ? (
        <textarea id={id} data-testid={id} rows={3} className={field} value={value} disabled={disabled} maxLength={o.maxLen} placeholder={o.placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : o.kind === "int" ? (
        <div className="flex items-center gap-3">
          <input id={id} data-testid={id} type="range" min={o.min} max={o.max} step={5} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className="w-48" />
          <span className="text-sm tabular-nums text-muted">{value}%</span>
        </div>
      ) : (
        <input id={id} data-testid={id} type={o.kind === "password" ? "password" : "text"} autoComplete={o.kind === "password" ? "new-password" : undefined} className={field}
          value={value} disabled={disabled} maxLength={o.maxLen} placeholder={o.placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
      {(() => { const hint = o.kind === "choice" ? o.choices?.find((ch) => ch.value === value)?.hint : undefined; return hint ? <p className="text-[12.5px] text-muted" data-testid={`${id}-hint`} aria-live="polite">{hint}</p> : null; })()}
      {o.help && <p className="text-[12.5px] text-muted">{o.help}</p>}
    </div>
  );
}

const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

/** One plain line about the result: pages, parts, tables, rows, or the checked redaction count. */
export function resultLine(job: ToolJob): string | null {
  const r = job.result;
  if (!r) return null;
  switch (job.op) {
    case "redact": return r.matches !== undefined ? `Blacked out ${n(r.matches, "match", "matches")}${r.verified ? ". Checked afterwards: none of the text can be found in the file" : ""}.` : null;
    case "split": return r.parts ? `${r.parts} PDFs in one ZIP.` : null;
    case "to-jpeg": return r.pages ? `${n(r.pages, "image", "images")} in one ZIP.` : null;
    case "pdf-to-docx": return r.pages_with_text ? `Text from ${n(r.pages_with_text, "page", "pages")}. Text and basic layout only.` : null;
    case "merge": case "images-to-pdf": case "ocr": case "to-pdf": return r.pages ? `${n(r.pages, "page", "pages")}.` : null;
    case "protect": return "Locked with your password. Keep the password somewhere safe.";
    case "stamp": return r.pages_changed ? `Added to ${n(r.pages_changed, "page", "pages")}.` : null;
    case "pdf-tables": return r.tables !== undefined ? (r.tables ? `${n(r.tables, "table", "tables")}, each on its own sheet.` : "No tables were found.") : null;
    case "excel-merge": return r.rows !== undefined ? `${n(r.rows, "row", "rows")}${r.sheets ? ` on ${n(r.sheets, "sheet", "sheets")}` : ""}.` : null;
    case "excel-clean": return r.rows !== undefined ? `${n(r.rows, "row", "rows")} kept${r.rows_removed ? `, ${n(r.rows_removed, "row", "rows")} removed` : ""}.` : null;
    case "scan-clean": return r.pages ? `${n(r.pages, "page", "pages")}${r.pages_with_text ? `, text found on ${r.pages_with_text}` : ""}.` : null;
    case "pii-find": return r.matches !== undefined ? `Found ${n(r.matches, "item", "items")}.` : null;
    default: return null;
  }
}

export function waitLine(tool: Pick<ToolDef, "slow"> | undefined, job: ToolJob, slow: boolean): string {
  const p = job.progress;
  if (tool?.slow && p && p.total > 0) {
    const left = Math.max(0, Math.round((p.total - p.done) * tool.slow.secondsPerPage));
    const eta = left >= 90 ? `about ${Math.round(left / 60)} minutes left` : left > 5 ? `about ${left} seconds left` : "almost done";
    return `Page ${Math.min(p.done + 1, p.total)} of ${p.total}, ${eta}`;
  }
  if (tool?.slow) return `Starting. This takes about ${tool.slow.secondsPerPage} ${tool.slow.secondsPerPage === 1 ? "second" : "seconds"} a page.`;
  return slow ? "Still working. Large files take a little longer." : "Working on it";
}
