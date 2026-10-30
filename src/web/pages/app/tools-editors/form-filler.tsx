/**
 * Tools P2, H7: fill a PDF form (Tools item 7). The engine lists the form's own fields; Multies shows
 * them as a plain web form (text, checkboxes, radio buttons, lists; required ones marked); the engine
 * fills them in and can flatten the result so the answers cannot be changed. A PDF without fields is
 * told so plainly, with a way to add typed text instead.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { IconFileEdit } from "@/web/components/ui/icon";
import { Button } from "@/web/components/ui/button";
import { Select } from "@/web/components/ui/input";
import { Card, EmptyState, Switch } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";
import {
  FIELD_VALUE_MAX, fieldLabel, initialValues, missingRequired, readFormFields, valuesToSend, type EditorJob, type FormField, type FormValues,
} from "@/shared/tools-editors";
import { readJson, start, useToolFeatures, waitFor, RunError, type Source, carriedPdfs, useTakeCarried } from "./runner";
import { BusyLine, EditorFrame, ErrorCard, PdfPicker, ResultCard } from "./shell";

type Phase = { kind: "pick" } | { kind: "reading"; pct: number | null } | { kind: "form" } | { kind: "empty" } | { kind: "filling"; pct: number | null } | { kind: "done"; job: EditorJob } | { kind: "failed"; error: RunError; back: "pick" | "form" };

const field = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition-colors duration-150 focus:border-brand disabled:opacity-60 max-sm:min-h-11";

function FieldRow({ f, value, onChange, disabled, showMissing }: { f: FormField; value: string | boolean | undefined; onChange: (v: string | boolean) => void; disabled: boolean; showMissing: boolean }) {
  const id = `form-field-${f.name.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const label = fieldLabel(f.name);
  const missing = showMissing && f.required && (f.type === "checkbox" ? value !== true : !String(value ?? "").trim());
  const mark = f.required ? <span className="text-bad" aria-hidden> *</span> : null;
  if (f.type === "signature") {
    return (
      <div className="rounded-lg border border-dashed border-line px-3 py-2 text-[13px] text-muted" data-testid="form-signature">
        <span className="font-medium text-fg">{label}</span>: a signature box. Sign it after filling, with a signature tool.
      </div>
    );
  }
  if (f.type === "checkbox") {
    return (
      <label className="flex items-start gap-2.5 py-1 text-sm max-sm:min-h-11" data-testid="form-field" data-name={f.name}>
        <input id={id} type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--color-brand,#0071E3)]" checked={value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-required={f.required || undefined} aria-invalid={missing || undefined} />
        <span>{label}{mark}</span>
      </label>
    );
  }
  const help = missing ? <p className="text-[12.5px] text-bad" id={`${id}-err`}>This one is required.</p> : null;
  if (f.type === "radio" && f.options.length) {
    return (
      <fieldset className="space-y-1" data-testid="form-field" data-name={f.name} aria-invalid={missing || undefined}>
        <legend className="mb-1 text-[13px] font-medium">{label}{mark}</legend>
        <div className="flex flex-wrap gap-2">
          {f.options.map((o) => (
            <label key={o} className={cn("inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm max-sm:min-h-11", value === o ? "border-brand bg-brand/5 font-medium" : "border-line hover:bg-hover")}>
              <input type="radio" name={id} value={o} checked={value === o} disabled={disabled} onChange={() => onChange(o)} className="sr-only" />{o}
            </label>
          ))}
        </div>
        {help}
      </fieldset>
    );
  }
  return (
    <div className="space-y-1" data-testid="form-field" data-name={f.name}>
      <label htmlFor={id} className="block text-[13px] font-medium">{label}{mark}</label>
      {(f.type === "choice" || f.type === "radio") && f.options.length ? (
        <Select id={id} value={String(value ?? "")} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-required={f.required || undefined} aria-invalid={missing || undefined}>
          <option value="">Choose</option>
          {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </Select>
      ) : (
        <input id={id} type="text" className={field} value={String(value ?? "")} disabled={disabled} maxLength={FIELD_VALUE_MAX} onChange={(e) => onChange(e.target.value)}
          aria-required={f.required || undefined} aria-invalid={missing || undefined} aria-describedby={missing ? `${id}-err` : undefined} />
      )}
      {help}
    </div>
  );
}

export function FormFillerPage() {
  const [params] = useSearchParams();
  const fromMail = params.get("attachment");
  const features = useToolFeatures();
  const [src, setSrc] = useState<Source | null>(() => (fromMail ? { kind: "attachment", id: fromMail, name: params.get("name") ?? "Attachment.pdf" } : carriedPdfs()[0] ?? null));
  useTakeCarried();
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const [fields, setFields] = useState<FormField[]>([]);
  const [values, setValues] = useState<FormValues>({});
  const [flatten, setFlatten] = useState(false);
  const [tried, setTried] = useState(false);
  const stop = useRef({ stopped: false });
  useEffect(() => () => { stop.current.stopped = true; }, []);

  useEffect(() => {
    if (!src) { setPhase({ kind: "pick" }); return; }
    const signal = { stopped: false };
    stop.current = signal;
    setPhase({ kind: "reading", pct: src.kind === "file" ? 0 : null });
    (async () => {
      try {
        const job = await waitFor(await start("form-fields", src, {}, (pct) => setPhase({ kind: "reading", pct })), () => undefined, signal);
        const list = readFormFields(await readJson(job));
        if (signal.stopped) return;
        setFields(list);
        setValues(initialValues(list));
        setTried(false);
        setPhase({ kind: list.some((f) => f.type !== "signature") ? "form" : "empty" });
      } catch (err) {
        if (!signal.stopped) setPhase({ kind: "failed", error: err instanceof RunError ? err : new RunError("The form could not be read."), back: "pick" });
      }
    })();
    return () => { signal.stopped = true; };
  }, [src]);

  const pages = useMemo(() => {
    const by = new Map<number, FormField[]>();
    for (const f of fields) { const p = f.page ?? 0; by.set(p, [...(by.get(p) ?? []), f]); }
    return [...by.entries()].sort((a, b) => a[0] - b[0]);
  }, [fields]);
  const missing = missingRequired(fields, values);
  const changes = valuesToSend(fields, values, flatten);
  const nothing = Object.keys(changes).length === 0;

  const fill = async () => {
    setTried(true);
    if (!src || nothing) return;
    const signal = { stopped: false };
    stop.current = signal;
    setPhase({ kind: "filling", pct: src.kind === "file" ? 0 : null });
    try {
      const job = await waitFor(await start("form-fill", src, { values: JSON.stringify(changes), flatten: flatten ? "yes" : "no" }, (pct) => setPhase({ kind: "filling", pct })), () => undefined, signal);
      setPhase({ kind: "done", job });
    } catch (err) {
      if (!signal.stopped) setPhase({ kind: "failed", error: err instanceof RunError ? err : new RunError("That didn't work. Try again."), back: "form" });
    }
  };
  const again = () => { setSrc(null); setFields([]); setValues({}); setFlatten(false); setPhase({ kind: "pick" }); };
  const busy = phase.kind === "reading" || phase.kind === "filling";
  const showForm = phase.kind === "form" || phase.kind === "filling" || (phase.kind === "failed" && phase.back === "form");
  const filled = phase.kind === "done" ? phase.job.result?.fields_filled : undefined;

  return (
    <EditorFrame feature="forms" title="Fill a PDF form" description="Type into a PDF form's own fields, then download it filled in." testId="form-filler">
      {phase.kind !== "done" && (
        <Card className="space-y-4 p-4">
          <PdfPicker label="PDF form" value={src} onChange={setSrc} disabled={busy} testId="form-pdf" />
          {phase.kind === "reading" && <BusyLine>{phase.pct !== null && phase.pct < 100 ? `Uploading ${phase.pct}%` : "Reading the form"}</BusyLine>}
        </Card>
      )}

      {phase.kind === "empty" && (
        <Card className="p-2" data-testid="form-empty">
          <EmptyState icon={<IconFileEdit />} title="This PDF has no form fields"
            body="There is nothing in it to fill in. To put typed text on the pages instead, add it as a stamp, header or footer."
            action={features.on("stamps") ? <Link to="/app/tools?op=stamp" className="text-sm font-medium text-brand" data-testid="form-to-stamp">Add text with Stamps</Link> : <Button type="button" variant="outline" onClick={again}>Choose another PDF</Button>} />
        </Card>
      )}

      {showForm && (
        <Card className="space-y-5 p-4" data-testid="form-card">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[15px] font-semibold">{fields.filter((f) => f.type !== "signature").length} fields</h2>
            {fields.some((f) => f.required) && <span className="text-[12.5px] text-muted"><span className="text-bad">*</span> Required</span>}
          </div>
          {pages.map(([page, list]) => (
            <section key={page} className="space-y-3" aria-label={page ? `Page ${page}` : "Fields"}>
              {pages.length > 1 && page > 0 && <h3 className="text-[12px] font-medium uppercase tracking-wide text-subtle">Page {page}</h3>}
              <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                {list.map((f) => (
                  <div key={f.name} className={cn(f.type === "radio" || f.type === "signature" ? "sm:col-span-2" : "")}>
                    <FieldRow f={f} value={values[f.name]} disabled={busy} showMissing={tried} onChange={(v) => setValues((cur) => ({ ...cur, [f.name]: v }))} />
                  </div>
                ))}
              </div>
            </section>
          ))}
          <div className="flex items-start justify-between gap-4 rounded-xl bg-fill px-3 py-3">
            <div>
              <div className="text-sm font-medium" id="flatten-label">Flatten so it cannot be changed</div>
              <div className="text-[12.5px] text-muted">The answers become part of the page. Nobody can edit them afterwards, you included.</div>
            </div>
            <span data-testid="form-flatten"><Switch checked={flatten} onChange={setFlatten} label="Flatten so it cannot be changed" disabled={busy} /></span>
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <Button type="button" onClick={fill} disabled={busy} loading={phase.kind === "filling"} data-testid="form-fill">Fill in PDF</Button>
            {phase.kind === "filling" && <BusyLine>{phase.pct !== null && phase.pct < 100 ? `Uploading ${phase.pct}%` : "Filling in"}</BusyLine>}
            {phase.kind !== "filling" && tried && nothing && <span className="text-[13px] text-muted" role="status">Change at least one answer first.</span>}
            {phase.kind !== "filling" && missing.length > 0 && <span className="text-[13px] text-muted" data-testid="form-missing">{missing.length} required {missing.length === 1 ? "field is" : "fields are"} still empty.</span>}
          </div>
        </Card>
      )}

      {phase.kind === "failed" && <ErrorCard error={phase.error} onRetry={phase.back === "pick" ? again : () => setPhase({ kind: "form" })} />}
      {phase.kind === "done" && <ResultCard job={phase.job} onAgain={again}
        facts={`${filled !== undefined ? `${filled} ${filled === 1 ? "field" : "fields"} filled in` : "Filled in"}${flatten ? ", flattened so it cannot be changed" : ""}.`} />}
    </EditorFrame>
  );
}
