/**
 * TD2 (FORMS_TD2): the public form with the Forms pro pieces: more answer types, layout blocks, file upload with
 * progress, signature, show, hide, require and disable logic, pages with a progress bar and one question at a time.
 * The same shared rules as the server (src/shared/form-logic.ts): what is hidden or disabled here is dropped there.
 * Page policy unchanged: our own code only (the upload uses the browser's own request object for progress).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useShield } from "@/web/lib/use-shield";
import { pickHidden } from "@/shared/forms-plus";
import { api, ApiError } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { Card } from "@/web/components/ui/misc";
import { Logo } from "@/web/components/logo";
import { IconAlertCircle, IconCheckCircle, IconClose, IconFileUp, IconStar, IconWifiOff } from "@/web/components/ui/icon";
import { checkAnswers, fieldStates, isLayout, isUpload, MULTI_SEPARATOR, ratingRange, type LogicField } from "@/shared/form-logic";
import { acceptFor, allowedKinds, FILE_KINDS, fieldMaxBytes, fieldMaxFiles, formatBytes, splitPages, steps, type Td2Settings } from "@/shared/forms-td2";
import { RatingInput, type PublicFormData } from "../forms-plus/chat-form";
import { SignaturePad } from "./signature-pad";
import { Td7SaveResume, td7Access, td7Body } from "../forms-td7/public-td7"; // TD7

export type Td2Field = LogicField & { placeholder?: string; hasImage?: boolean };
export interface Td2PublicForm { name: string; description: string; workspace: string; fields: Td2Field[]; td2: Td2Settings; plus?: PublicFormData["plus"] }

interface UploadItem { key: number; name: string; size: number; pct: number; id?: string; error?: string }

/** One upload with progress (fetch has no upload progress). */
function sendUpload(url: string, file: Blob, name: string, onPct: (n: number) => void, access?: string): Promise<{ id: string; name: string; size: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("x-multies-upload", "1");
    xhr.setRequestHeader("x-file-name", encodeURIComponent(name));
    xhr.setRequestHeader("content-type", "application/octet-stream");
    if (access) xhr.setRequestHeader("x-form-access", access); // TD7: password forms
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onPct(Math.round((e.loaded / e.total) * 100)); };
    xhr.onerror = () => reject(new Error("Couldn't send the file. Check your connection and try again."));
    xhr.onload = () => {
      let body: { id?: string; name?: string; size?: number; error?: { message?: string } } | null = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && body?.id) resolve({ id: body.id, name: body.name ?? name, size: body.size ?? file.size });
      else reject(new Error(body?.error?.message ?? "That file didn't upload. Try again."));
    };
    xhr.send(file);
  });
}

const extOk = (f: Td2Field, file: File) => {
  const kinds = allowedKinds(f);
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(file.name)?.[1] ?? "").toLowerCase();
  const byKind: Record<string, string[]> = { images: ["png", "jpg", "jpeg", "gif", "webp"], pdf: ["pdf"], documents: ["docx", "pptx"], spreadsheets: ["xlsx", "csv"], text: ["txt"] };
  return kinds.some((k) => byKind[k].includes(ext));
};

function FileField({ slug, field, items, setItems, labelId, errId, disabled }: {
  slug: string; field: Td2Field; items: UploadItem[]; setItems: (fn: (prev: UploadItem[]) => UploadItem[]) => void; labelId: string; errId?: string; disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const most = fieldMaxFiles(field);
  const max = fieldMaxBytes(field);
  const kinds = FILE_KINDS.filter((k) => allowedKinds(field).includes(k.id)).map((k) => k.hint).join(", ");
  const live = items.filter((i) => !i.error);
  const add = (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files).slice(0, Math.max(0, most - live.length))) {
      const key = Date.now() + Math.random();
      const base: UploadItem = { key, name: file.name, size: file.size, pct: 0 };
      if (file.size > max) { setItems((p) => [...p, { ...base, error: `Too big. Files can be up to ${formatBytes(max)} here.` }]); continue; }
      if (!extOk(field, file)) { setItems((p) => [...p, { ...base, error: `This file type isn't accepted here. You can send: ${kinds}.` }]); continue; }
      setItems((p) => [...p, base]);
      sendUpload(`/api/public/forms/${encodeURIComponent(slug)}/uploads?field=${encodeURIComponent(field.id)}`, file, file.name, (pct) => setItems((p) => p.map((x) => (x.key === key ? { ...x, pct } : x))), td7Access(slug))
        .then((r) => setItems((p) => p.map((x) => (x.key === key ? { ...x, id: r.id, name: r.name, pct: 100 } : x))))
        .catch((e: Error) => setItems((p) => p.map((x) => (x.key === key ? { ...x, error: e.message } : x))));
    }
    if (input.current) input.current.value = "";
  };
  return (
    <div data-testid={`file-${field.id}`}>
      <div className={`rounded-lg border border-dashed border-line p-4 text-center ${disabled ? "opacity-60" : ""}`}
        onDragOver={(e) => { if (!disabled) e.preventDefault(); }} onDrop={(e) => { e.preventDefault(); if (!disabled) add(e.dataTransfer.files); }}>
        <IconFileUp className="mx-auto h-6 w-6 text-subtle" aria-hidden="true" />
        <p className="mt-1 text-[13px] text-muted">Drop {most === 1 ? "a file" : `up to ${most} files`} here, or</p>
        <input ref={input} id={`${field.id}-input`} name={field.id} type="file" className="sr-only" multiple={most > 1} accept={acceptFor(field)} disabled={disabled || live.length >= most}
          aria-labelledby={labelId} aria-describedby={[`${field.id}-hint`, errId].filter(Boolean).join(" ")} onChange={(e) => add(e.target.files)} />
        <label htmlFor={`${field.id}-input`} className={`mt-2 inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-line bg-surface px-4 text-[14px] font-medium hover:bg-hover focus-within:ring-2 focus-within:ring-brand ${disabled || live.length >= most ? "pointer-events-none opacity-60" : ""}`}>
          Choose {most === 1 ? "a file" : "files"}
        </label>
        <p id={`${field.id}-hint`} className="mt-2 text-[12px] text-subtle">{kinds}. Up to {formatBytes(max)} each.</p>
      </div>
      {items.length > 0 && (
        <ul className="mt-2 space-y-1.5" aria-live="polite">
          {items.map((it) => (
            <li key={it.key} className="rounded-lg border border-line px-3 py-2 text-[13px]" data-testid="upload-item">
              <div className="flex items-center gap-2">
                {it.error ? <IconAlertCircle className="h-4 w-4 shrink-0 text-bad" aria-hidden="true" /> : it.id ? <IconCheckCircle className="h-4 w-4 shrink-0 text-good" aria-hidden="true" /> : null}
                <span className="min-w-0 flex-1 truncate">{it.name}</span>
                <span className="shrink-0 text-subtle">{formatBytes(it.size)}</span>
                <button type="button" onClick={() => setItems((p) => p.filter((x) => x.key !== it.key))} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-subtle hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand" aria-label={`Remove ${it.name}`}>
                  <IconClose className="h-3.5 w-3.5" />
                </button>
              </div>
              {it.error ? <p role="alert" className="mt-1 text-[12.5px] text-bad">{it.error}</p> : !it.id && (
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-elevated" role="progressbar" aria-label={`Uploading ${it.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={it.pct}>
                  <div className="h-full bg-brand transition-[width] duration-150 motion-reduce:transition-none" style={{ width: `${it.pct}%` }} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Stars({ field, value, onChange, labelledBy, disabled }: { field: Td2Field; value: string; onChange: (v: string) => void; labelledBy: string; disabled?: boolean }) {
  const { min, max } = ratingRange(field);
  const from = Math.max(1, min);
  const n = max - from + 1;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const cur = Number(value) || 0;
  const key = (e: ReactKeyboardEvent, i: number) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const j = Math.min(n - 1, Math.max(0, i + d));
    onChange(String(from + j)); refs.current[j]?.focus();
  };
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="flex gap-1" data-testid={`stars-${field.id}`}>
      {Array.from({ length: n }, (_, i) => {
        const v = from + i;
        return (
          <button key={v} ref={(el) => { refs.current[i] = el; }} type="button" role="radio" aria-checked={cur === v} aria-label={`${v} star${v === 1 ? "" : "s"}`} disabled={disabled}
            tabIndex={cur === v || (!cur && i === 0) ? 0 : -1} onClick={() => onChange(String(v))} onKeyDown={(e) => key(e, i)}
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-warn hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50">
            <IconStar filled={cur >= v} className="h-7 w-7" />
          </button>
        );
      })}
    </div>
  );
}

export function PublicFormTd2({ slug, form, oneAtATime: forceOne, embed }: { slug: string; form: Td2PublicForm; oneAtATime?: boolean; embed?: boolean }) {
  const qc = useQueryClient();
  const shield = useShield("fplus", "/pub/forms/shield", !!form.plus);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [uploads, setUploads] = useState<Record<string, UploadItem[]>>({});
  const [signed, setSigned] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [trap, setTrap] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine !== false);
  const [at, setAt] = useState(0);
  const opened = useRef(Date.now());
  const top = useRef<HTMLDivElement>(null);
  const oneAtATime = !!(forceOne || form.td2.oneAtATime);

  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  const fields = form.fields;
  const logicFields = useMemo(() => fields.map((x) => ({ ...x, required: !!x.required })), [fields]);
  // Upload answers are the ids of finished uploads; the logic reads them like any answer.
  const all: Record<string, string | string[]> = { ...answers };
  for (const f of fields) if (isUpload(f.type)) { const ids = (uploads[f.id] ?? []).filter((u) => u.id).map((u) => u.id!); if (ids.length) all[f.id] = ids; else delete all[f.id]; }
  const states = fieldStates(logicFields, all);
  const visible = (f: Td2Field) => states.shown.has(f.id);

  // Screens: pages split at page breaks, or one question (or block) at a time; empty screens are skipped.
  const screens = useMemo(() => (oneAtATime ? steps(fields).map((f) => [f]) : splitPages(fields)), [fields, oneAtATime]);
  const live = screens.map((s, i) => ({ i, items: s.filter(visible) })).filter((s) => s.items.length);
  const pos = Math.max(0, Math.min(live.findIndex((s) => s.i >= at) === -1 ? live.length - 1 : live.findIndex((s) => s.i >= at), live.length - 1));
  const screen = live[pos]?.items ?? [];
  const last = pos >= live.length - 1;
  const pending = Object.values(uploads).some((list) => list.some((u) => !u.id && !u.error));

  const setAnswer = (id: string, v: string | string[]) => { setAnswers((a) => ({ ...a, [id]: v })); if (errors[id]) setErrors((er) => { const n = { ...er }; delete n[id]; return n; }); };
  const errorsFor = (items: Td2Field[]) => {
    const checked = checkAnswers(logicFields, all, undefined, { strict: true });
    const ids = new Set(items.map((x) => x.id));
    return Object.fromEntries(Object.entries(checked.errors).filter(([k]) => ids.has(k)));
  };
  const focusFirst = (errs: Record<string, string>) => {
    const first = logicFields.find((x) => errs[x.id]);
    if (first) (document.querySelector<HTMLElement>(`[name="${first.id}"]`) ?? document.getElementById(`${first.id}-label`))?.focus();
  };
  const wantFocus = useRef(false);
  const moveTo = (p: number) => { wantFocus.current = true; setAt(live[p]?.i ?? 0); };
  // After the screen changes, focus its first question (or its heading) so keyboard and screen reader users follow.
  useEffect(() => {
    if (!wantFocus.current) return;
    wantFocus.current = false;
    const el = top.current?.querySelector<HTMLElement>("form [data-step] input:not([type=hidden]):not(.sr-only), form [data-step] textarea, form [data-step] select, form [data-step] [role=radio], form [data-step] h2");
    if (el) { if (el.tagName === "H2") el.setAttribute("tabindex", "-1"); el.focus(); }
  }, [pos, at]);
  // One question at a time starts on the first question, ready to type.
  useEffect(() => { if (oneAtATime) top.current?.querySelector<HTMLElement>("form [data-step] input:not(.sr-only), form [data-step] textarea, form [data-step] select")?.focus(); }, [oneAtATime]);
  const next = () => {
    const errs = errorsFor(screen);
    setErrors(errs);
    if (Object.keys(errs).length) { focusFirst(errs); return; }
    if (pending) { setErrors({ _: "Please wait for your files to finish uploading." }); return; }
    moveTo(pos + 1);
  };
  const back = () => { if (pos > 0) moveTo(pos - 1); };

  const submit = async () => {
    const checked = checkAnswers(logicFields, all, undefined, { strict: true });
    setErrors(checked.errors);
    if (Object.keys(checked.errors).length) {
      const first = logicFields.find((x) => checked.errors[x.id]);
      const idx = live.findIndex((s) => s.items.some((x) => x.id === first?.id));
      if (idx >= 0 && idx !== pos) setAt(live[idx].i);
      requestAnimationFrame(() => focusFirst(checked.errors));
      return;
    }
    if (pending) { setErrors({ _: "Please wait for your files to finish uploading." }); return; }
    if (!online) return;
    setBusy(true);
    try {
      const sendable = Object.fromEntries(Object.entries(all).filter(([k]) => states.shown.has(k) && !states.disabled.has(k)));
      const hidden = form.plus ? pickHidden(form.plus.hiddenFields, new URLSearchParams(window.location.search)) : undefined;
      const r = await shield.send((sh) => api.post<{ ok: boolean; message: string }>(`/public/forms/${slug}`, { ...td7Body(slug), answers: sendable, website: trap, elapsedMs: Date.now() - opened.current, hidden, shield: sh ? { ...sh, hp: trap } : undefined }));
      setDone(r.message);
      void qc.invalidateQueries({ queryKey: ["public-form", slug] });
    } catch (e) {
      if (e instanceof ApiError && e.fields && Object.keys(e.fields).length) {
        setErrors(e.fields);
        // An upload the server no longer accepts has to be added again.
        for (const k of Object.keys(e.fields)) if (isUpload(fields.find((x) => x.id === k)?.type)) { setUploads((u) => ({ ...u, [k]: [] })); setSigned((s) => ({ ...s, [k]: false })); }
        focusFirst(e.fields);
      } else showError(e as Error);
    } finally { setBusy(false); }
  };

  const onKey = (e: ReactKeyboardEvent<HTMLFormElement>) => {
    if (!oneAtATime || e.key !== "Enter") return;
    const t = e.target as HTMLElement;
    if (t.tagName === "TEXTAREA" && !e.shiftKey) return; // a new line in long text
    if (t.tagName === "BUTTON" || t.tagName === "A") return;
    e.preventDefault();
    if (e.shiftKey) back(); else if (last) void submit(); else next();
  };

  const total = live.length;
  const progress = total > 1 ? Math.round(((pos + (done ? 1 : 0)) / total) * 100) : 0;

  const render = (x: Td2Field) => {
    const value = all[x.id];
    const text = Array.isArray(value) ? value.join(MULTI_SEPARATOR) : (value ?? "");
    const required = states.required.has(x.id);
    const disabled = states.disabled.has(x.id);
    const label = `${x.label}${required || isLayout(x.type) ? "" : " (optional)"}`;
    const err = errors[x.id];
    const errId = err ? `${x.id}-err` : undefined;
    const animate = x.logic ? "animate-pop-in motion-reduce:animate-none" : undefined;
    const note = disabled ? <p className="mt-1 text-[12px] text-subtle">Not needed for your answers so far.</p> : null;
    const errLine = err ? <p id={errId} role="alert" className="mt-1 text-[12.5px] text-bad">{err}</p> : null;
    if (x.type === "heading") return <div key={x.id} className={animate}><h2 className="text-lg font-semibold tracking-tight">{x.label}</h2>{x.text && <p className="mt-1 whitespace-pre-wrap text-[14px] text-muted">{x.text}</p>}</div>;
    if (x.type === "paragraph") return <p key={x.id} className={`whitespace-pre-wrap text-[14px] text-muted ${animate ?? ""}`}>{x.text}</p>;
    if (x.type === "divider") return <hr key={x.id} className="border-line" />;
    if (x.type === "image") return x.hasImage ? <img key={x.id} src={`/api/public/forms/${encodeURIComponent(slug)}/images/${encodeURIComponent(x.id)}`} alt={x.imageAlt ?? ""} loading="lazy" className="max-h-80 w-full rounded-lg object-contain" /> : null;
    if (x.type === "file") return (
      <div key={x.id} className={animate}>
        <div id={`${x.id}-label`} className="mb-1.5 text-[13px] font-medium">{label}</div>
        <FileField slug={slug} field={x} items={uploads[x.id] ?? []} disabled={disabled} labelId={`${x.id}-label`} errId={errId}
          setItems={(fn) => { setUploads((u) => ({ ...u, [x.id]: fn(u[x.id] ?? []) })); setErrors((er) => { const n = { ...er }; delete n[x.id]; delete n._; return n; }); }} />
        {note}{errLine}
      </div>
    );
    if (x.type === "signature") return (
      <div key={x.id} className={animate}>
        <div id={`${x.id}-label`} className="mb-1.5 text-[13px] font-medium">{label}</div>
        <SignaturePad id={x.id} labelledBy={`${x.id}-label`} describedBy={errId} disabled={disabled || busy} signed={!!signed[x.id]}
          onClear={() => { setUploads((u) => ({ ...u, [x.id]: [] })); setSigned((s) => ({ ...s, [x.id]: false })); }}
          onDone={(png) => {
            const key = Date.now();
            setUploads((u) => ({ ...u, [x.id]: [{ key, name: "signature.png", size: png.size, pct: 0 }] }));
            sendUpload(`/api/public/forms/${encodeURIComponent(slug)}/uploads?field=${encodeURIComponent(x.id)}`, png, "signature.png", () => undefined, td7Access(slug))
              .then((r) => { setUploads((u) => ({ ...u, [x.id]: [{ key, name: r.name, size: r.size, pct: 100, id: r.id }] })); setSigned((s) => ({ ...s, [x.id]: true })); setErrors((er) => { const n = { ...er }; delete n[x.id]; return n; }); })
              .catch((e: Error) => { setUploads((u) => ({ ...u, [x.id]: [] })); setErrors((er) => ({ ...er, [x.id]: e.message })); });
          }} />
        {signed[x.id] && <p className="mt-1 text-[12.5px] text-good" role="status">Signature saved.</p>}
        {note}{errLine}
      </div>
    );
    if (x.type === "rating") return (
      <div key={x.id} className={animate}>
        <div id={`${x.id}-label`} className="mb-1.5 text-[13px] font-medium">{label}</div>
        {x.display === "stars" ? <Stars field={x} value={text} labelledBy={`${x.id}-label`} disabled={disabled} onChange={(v) => setAnswer(x.id, v)} />
          : <RatingInput field={x as PublicFormData["fields"][number]} value={text} labelledBy={`${x.id}-label`} onChange={(v) => setAnswer(x.id, v)} />}
        {note}{errLine}
      </div>
    );
    if (x.type === "multiselect") {
      const picked = Array.isArray(value) ? value : [];
      return (
        <fieldset key={x.id} className={animate} disabled={disabled} aria-invalid={err ? true : undefined} aria-describedby={errId}>
          <legend id={`${x.id}-label`} className="mb-1.5 text-[13px] font-medium">{label}</legend>
          <div className="space-y-1.5">
            {x.options?.map((o, oi) => (
              <label key={o} className="flex min-h-11 items-center gap-2 text-[14px] sm:min-h-0">
                <input type="checkbox" name={oi === 0 ? x.id : undefined} className="h-4 w-4 rounded border-line accent-brand focus-visible:ring-2 focus-visible:ring-brand" checked={picked.includes(o)}
                  onChange={(e) => setAnswer(x.id, e.target.checked ? [...picked, o] : picked.filter((p) => p !== o))} />{o}
              </label>
            ))}
          </div>
          {note}{errLine}
        </fieldset>
      );
    }
    const common = { name: x.id, "aria-required": required || undefined, value: text, placeholder: x.placeholder, disabled, onChange: (e: { target: { value: string } }) => setAnswer(x.id, e.target.value) };
    const inputType = x.type === "phone" ? "tel" : x.type === "datetime" ? "datetime-local" : x.type === "text" ? "text" : x.type;
    return (
      <div key={x.id} className={animate} data-testid={`q-${x.id}`}>
        <Field label={label} error={err} hint={disabled ? "Not needed for your answers so far." : undefined}>{(fp) => (x.type === "textarea" ? <Textarea {...fp} {...common} className="min-h-28" />
          : x.type === "select" ? <Select {...fp} {...common}><option value="">Choose one</option>{x.options?.map((o) => <option key={o} value={o}>{o}</option>)}</Select>
          : <Input {...fp} {...common} type={inputType} inputMode={x.type === "number" ? "decimal" : x.type === "url" ? "url" : undefined}
              min={x.type === "number" ? x.rules?.min : undefined} max={x.type === "number" ? x.rules?.max : undefined}
              autoComplete={x.type === "email" ? "email" : x.type === "phone" ? "tel" : x.type === "url" ? "url" : /name/i.test(x.label) ? "name" : undefined} />)}</Field>
      </div>
    );
  };

  return (
    <main className={`min-h-dvh bg-bg text-fg ${embed ? "px-3 py-4" : "px-4 py-10"}`}>
      <div className="mx-auto max-w-lg" ref={top}>
        {!online && (
          <div role="status" className="mb-3 flex items-center gap-2 rounded-lg border border-line bg-elevated px-3 py-2 text-[13px]" data-testid="form-offline">
            <IconWifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />You're offline. Your answers stay here; send them when you're back online.
          </div>
        )}
        {done ? (
          <Card className="p-8 text-center" data-testid="form-done"><h1 className="text-lg font-semibold">Sent</h1><p className="mt-2 text-[14px] text-muted">{done}</p></Card>
        ) : (
          <Card className="p-6 sm:p-8">
            <p className="text-[12.5px] text-muted">{form.workspace}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">{form.name}</h1>
            {form.description && pos === 0 && <p className="mt-2 whitespace-pre-wrap text-[14px] text-muted">{form.description}</p>}
            {form.td2.progress && total > 1 && (
              <div className="mt-4" data-testid="form-progress">
                <div className="mb-1 flex justify-between text-[12px] text-muted" aria-hidden="true"><span>{oneAtATime ? `Question ${pos + 1} of ${total}` : `Page ${pos + 1} of ${total}`}</span><span>{progress}%</span></div>
                <div className="h-1.5 overflow-hidden rounded-full bg-elevated" role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}
                  aria-valuetext={oneAtATime ? `Question ${pos + 1} of ${total}` : `Page ${pos + 1} of ${total}`}>
                  <div className="h-full bg-brand transition-[width] duration-200 motion-reduce:transition-none" style={{ width: `${progress}%` }} />
                </div>
              </div>
            )}
            <p className="sr-only" aria-live="polite">{total > 1 ? (oneAtATime ? `Question ${pos + 1} of ${total}` : `Page ${pos + 1} of ${total}`) : ""}</p>
            <form className="mt-6 space-y-5" noValidate onKeyDown={onKey} onSubmit={(e) => { e.preventDefault(); if (last) void submit(); else next(); }} data-testid="public-form" data-mode={oneAtATime ? "one" : "pages"}>
              <div data-step className="space-y-5">{screen.map(render)}</div>
              {/* A trap for bots: hidden from people and screen readers. */}
              <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", width: 1, height: 1, overflow: "hidden" }}>
                <label>Website<input tabIndex={-1} autoComplete="off" value={trap} onChange={(e) => setTrap(e.target.value)} name="website" /></label>
              </div>
              {errors._ && <p role="alert" className="text-[12.5px] text-bad">{errors._}</p>}
              <div className="flex items-center gap-2 pt-1">
                {pos > 0 && <Button type="button" variant="ghost" onClick={back} data-testid="form-back">Back</Button>}
                <Button type="submit" className="flex-1" loading={busy} disabled={!online && last} data-testid={last ? "form-send" : "form-next"}>{last ? "Send" : "Next"}</Button>
              </div>
              <Td7SaveResume slug={slug} form={form} answers={answers} onRestore={setAnswers} />
              {oneAtATime && <p className="text-center text-[12px] text-subtle">Press Enter for next, Shift and Enter to go back.</p>}
            </form>
          </Card>
        )}
        {!embed && <div className="mt-6 flex items-center justify-center gap-2 text-[12px] text-subtle">Form by <Logo className="h-4" /></div>}
      </div>
    </main>
  );
}
