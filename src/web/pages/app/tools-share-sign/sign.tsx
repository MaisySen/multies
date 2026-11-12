/**
 * Tools P2: e-sign. Open a PDF (upload, a Tools result with ?result=<token>, or a mail attachment with
 * ?attachment=<id>), place fields on the page pictures, then either sign it yourself or ask others to sign
 * (each gets their own link by email from your mailbox, in the same thread when it came from one). The
 * Requests tab shows who has signed, viewed or declined, and each request's signing record.
 * Hidden unless GET /api/tools lists the "esign" feature.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { useConfig, useOpenableMailboxes } from "@/web/lib/queries";
import { Button } from "@/web/components/ui/button";
import { Select } from "@/web/components/ui/input";
import { Badge, Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { ToolsFrame } from "@/web/components/tools/tools-frame";
import { IconClose, IconDownload, IconFileUp, IconPenLine, IconPlus, IconSend } from "@/web/components/ui/icon";
import { ESIGN_NOTE, type SignField, type SignPage, type SignRequestInfo, type SignerStatus } from "@/shared/share-sign";
import type { ToolsInfo } from "@/shared/tools";
import { SignaturePad, type FieldKind, type SignaturePadHandle } from "./signature-pad";
import { TemplatesPanel } from "./templates";

/** R107: an event time in the signer's own time zone, when the signing page sent one. */
const localAt = (iso: string, tz?: string | null) => {
  if (!tz) return "";
  try { return new Date(iso).toLocaleString("en-AU", { timeZone: tz, day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" }); } catch { return ""; }
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");
const SIGNER_COLORS = ["#0071E3", "#AF52DE", "#FF9500", "#34C759", "#FF2D55", "#5AC8FA", "#A2845E", "#5856D6", "#FF3B30", "#30B0C7"];
/** R107 adds text and checkbox fields for signers (requests only). */
type PlaceKind = SignField["kind"];
const DEFAULT_SIZE: Record<PlaceKind, { w: number; h: number }> = { signature: { w: 180, h: 50 }, initials: { w: 70, h: 36 }, date: { w: 110, h: 22 }, text: { w: 160, h: 24 }, checkbox: { w: 20, h: 20 } };
const KIND_LABEL: Record<PlaceKind, string> = { signature: "Signature", initials: "Initials", date: "Date", text: "Text", checkbox: "Checkbox" };

function uploadPdf(file: File): Promise<SignRequestInfo> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append("file", file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/tools/esign/documents");
    xhr.withCredentials = true;
    xhr.setRequestHeader("x-multies-upload", "1");
    xhr.onerror = () => reject(new Error("Couldn't reach Multies. Check your connection and try again."));
    xhr.onload = () => {
      let body: { error?: { message?: string } } & Partial<SignRequestInfo> = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status === 201) resolve(body as SignRequestInfo);
      else reject(new Error(body.error?.message || "That didn't work. Try again."));
    };
    xhr.send(fd);
  });
}

/** The page pictures with fields on top: drag to move, the corner to resize, arrow keys to nudge, Delete to remove. */
function PagePlacer({ pages, fields, setFields, selected, setSelected, labelOf, colorOf }: {
  pages: SignPage[]; fields: SignField[]; setFields: (f: SignField[]) => void; selected: number | null; setSelected: (i: number | null) => void;
  labelOf: (f: SignField) => string; colorOf: (f: SignField) => string;
}) {
  const drag = useRef<{ i: number; mode: "move" | "size"; sx: number; sy: number; f: SignField; scale: number } | null>(null);
  const start = (e: RPointerEvent, i: number, mode: "move" | "size", page: SignPage) => {
    e.stopPropagation(); e.preventDefault();
    const el = (e.currentTarget as HTMLElement).closest("[data-page]") as HTMLElement;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { i, mode, sx: e.clientX, sy: e.clientY, f: fields[i], scale: page.width / el.getBoundingClientRect().width };
    setSelected(i);
  };
  const move = (e: RPointerEvent, page: SignPage) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.sx) * d.scale, dy = (e.clientY - d.sy) * d.scale;
    const next = [...fields];
    if (d.mode === "move") next[d.i] = { ...d.f, x: Math.round(Math.min(Math.max(0, d.f.x + dx), page.width - d.f.w)), y: Math.round(Math.min(Math.max(0, d.f.y + dy), page.height - d.f.h)) };
    else next[d.i] = { ...d.f, w: Math.round(Math.min(Math.max(20, d.f.w + dx), page.width - d.f.x)), h: Math.round(Math.min(Math.max(10, d.f.h + dy), page.height - d.f.y)) };
    setFields(next);
  };
  const key = (e: KeyboardEvent, i: number, page: SignPage) => {
    const f = fields[i];
    const step = e.shiftKey ? 10 : 2;
    let n: SignField | null = null;
    if (e.key === "ArrowLeft") n = { ...f, x: Math.max(0, f.x - step) };
    if (e.key === "ArrowRight") n = { ...f, x: Math.min(page.width - f.w, f.x + step) };
    if (e.key === "ArrowUp") n = { ...f, y: Math.max(0, f.y - step) };
    if (e.key === "ArrowDown") n = { ...f, y: Math.min(page.height - f.h, f.y + step) };
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); setFields(fields.filter((_, j) => j !== i)); setSelected(null); return; }
    if (n) { e.preventDefault(); const next = [...fields]; next[i] = n; setFields(next); }
  };
  return (
    <div className="space-y-4" onPointerDown={() => setSelected(null)}>
      {pages.map((p) => (
        <figure key={p.page} className="mx-auto max-w-[640px]">
          <div data-page={p.page} className="relative overflow-hidden rounded-md border border-line bg-white shadow-sm" style={{ aspectRatio: `${p.width} / ${p.height}` }}>
            {p.img ? <img src={p.img} alt={`Page ${p.page}`} className="absolute inset-0 h-full w-full select-none" draggable={false} /> : <div className="absolute inset-0 grid place-items-center text-sm text-muted">Page {p.page}</div>}
            {fields.map((f, i) => f.page !== p.page ? null : (
              <div key={i} role="button" tabIndex={0} aria-label={`${labelOf(f)} field on page ${p.page}. Arrow keys move it, Delete removes it.`} data-testid="sign-field" data-index={i}
                onPointerDown={(e) => start(e, i, "move", p)} onPointerMove={(e) => move(e, p)} onPointerUp={() => { drag.current = null; }} onKeyDown={(e) => key(e, i, p)} onFocus={() => setSelected(i)}
                className="absolute flex cursor-move touch-none items-center justify-center rounded border-2 text-[11px] font-medium"
                style={{ left: `${(f.x / p.width) * 100}%`, top: `${(f.y / p.height) * 100}%`, width: `${(f.w / p.width) * 100}%`, height: `${(f.h / p.height) * 100}%`, borderColor: colorOf(f), background: `${colorOf(f)}22`, color: colorOf(f), outline: selected === i ? `2px solid ${colorOf(f)}` : undefined, outlineOffset: 2 }}>
                <span className="truncate px-1">{labelOf(f)}</span>
                {selected === i && <button type="button" aria-label="Remove field" className="absolute -right-2.5 -top-2.5 grid h-5 w-5 place-items-center rounded-full bg-fg text-bg" onPointerDown={(e) => { e.stopPropagation(); setFields(fields.filter((_, j) => j !== i)); setSelected(null); }}><IconClose className="h-3 w-3" /></button>}
                <span aria-hidden="true" className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-sm border-2 bg-white" style={{ borderColor: colorOf(f) }} onPointerDown={(e) => start(e, i, "size", p)} onPointerMove={(e) => move(e, p)} onPointerUp={() => { drag.current = null; }} />
              </div>
            ))}
          </div>
          <figcaption className="mt-1 text-center text-[12px] text-muted">Page {p.page} of {pages.length}</figcaption>
        </figure>
      ))}
    </div>
  );
}

function NewDocument() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const mailboxes = useOpenableMailboxes(); // PRIV1b (WC5): only mailboxes this person can open
  const [draft, setDraft] = useState<SignRequestInfo | null>(null);
  const [pages, setPages] = useState<SignPage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"self" | "request">(params.get("mode") === "request" ? "request" : "self");
  const [fields, setFields] = useState<SignField[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [padReady, setPadReady] = useState(false);
  const pad = useRef<SignaturePadHandle>(null);
  const [signers, setSigners] = useState<{ name: string; email: string }[]>([{ name: "", email: "" }]);
  const [order, setOrder] = useState<"any" | "sequence">("any");
  const [message, setMessage] = useState("");
  const [mailboxId, setMailboxId] = useState("");
  // R67 (QA5 #17): with only one mailbox, it is the one the request goes from.
  useEffect(() => { const list = mailboxes.data ?? []; if (!mailboxId && list.length === 1) setMailboxId(list[0].id); }, [mailboxes.data, mailboxId]);
  const [days, setDays] = useState(14);
  const [remind, setRemind] = useState(3);
  const [selfDone, setSelfDone] = useState<SignRequestInfo | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const attachment = params.get("attachment");
  const result = params.get("result");
  const started = useRef(false);

  const begin = useCallback(async (from: () => Promise<SignRequestInfo>) => {
    setError(null); setBusy(true);
    try { setDraft(await from()); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }, []);
  useEffect(() => {
    if (started.current || (!attachment && !result)) return;
    started.current = true;
    void begin(() => api.post<SignRequestInfo>("/tools/esign/documents/from", attachment ? { source: "attachment", attachmentId: attachment } : { source: "result", token: result }));
  }, [attachment, result, begin]);
  useEffect(() => {
    if (!draft || pages) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await api.get<{ status: string; pages?: SignPage[]; error?: string }>(`/tools/esign/${draft.id}/pages`);
        if (stop) return;
        if (r.status === "done" && r.pages) setPages(r.pages);
        else if (r.status === "failed") setError(r.error ?? "That PDF could not be read.");
        else setTimeout(tick, 1500);
      } catch (e) { if (!stop) setError(errorMessage(e)); }
    };
    void tick();
    return () => { stop = true; };
  }, [draft, pages]);
  useEffect(() => {
    if (!selfDone || selfDone.status !== "finishing") return;
    const t = setTimeout(async () => { try { setSelfDone(await api.get<SignRequestInfo>(`/tools/esign/${selfDone.id}`)); } catch (e) { setError(errorMessage(e)); } }, 2000);
    return () => clearTimeout(t);
  }, [selfDone]);

  const add = (kind: PlaceKind, signer = 0) => {
    const p = pages?.find((x) => x.page === page) ?? pages?.[0];
    if (!p) return;
    const s = DEFAULT_SIZE[kind];
    // Stack new fields under the ones already on this page so they never land on top of each other.
    const below = fields.filter((f) => f.page === p.page).reduce((y, f) => Math.max(y, f.y + f.h + 10), p.height * 0.7);
    const y = below + s.h > p.height - 10 ? p.height * 0.1 : below;
    setFields([...fields, { signer, kind, page: p.page, x: Math.round(Math.min(p.width - s.w, 60)), y: Math.round(y), w: s.w, h: s.h }]);
    setSelected(fields.length);
    // Bring the new field into view: it lands low on the page (where signature lines usually are), often below the fold.
    const idx = fields.length;
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-testid="sign-field"][data-index="${idx}"]`);
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      el?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    });
  };
  const labelOf = (f: SignField) => (mode === "request" ? `${f.label || KIND_LABEL[f.kind]}: ${signers[f.signer]?.name || `Signer ${f.signer + 1}`}` : KIND_LABEL[f.kind]);
  // R107: templates (ESIGN_V2): the signers' names become the template's roles.
  const esign = useQuery({ queryKey: ["tools-esign"], queryFn: () => api.get<{ requests: SignRequestInfo[]; v2?: boolean }>("/tools/esign") });
  const v2 = !!esign.data?.v2;
  const [tplName, setTplName] = useState<string | null>(null);
  const saveTemplate = async () => {
    if (!draft || !tplName?.trim()) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/tools/esign/${draft.id}/template`, { name: tplName.trim(), roles: signers.map((s, i) => s.name.trim() || `Signer ${i + 1}`), fields, order, message: message.trim() || undefined, expiresDays: days, remindDays: remind });
      toast.success("Template saved");
      setTplName(null);
      await qc.invalidateQueries({ queryKey: ["tools-esign-templates"] });
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const sel = selected !== null ? fields[selected] : undefined;
  const templateReady = signers.every((_, i) => fields.some((f) => f.signer === i && f.kind === "signature"));
  const colorOf = (f: SignField) => SIGNER_COLORS[mode === "request" ? f.signer % SIGNER_COLORS.length : 0];

  const signSelf = async () => {
    if (!draft || !pad.current?.ready()) return;
    setBusy(true); setError(null);
    try {
      const own = fields.map((f) => ({ ...f, signer: 0 }));
      const images = own.map((f) => pad.current!.makeImage(f.kind as FieldKind, f.w, f.h));
      setSelfDone(await api.post<SignRequestInfo>(`/tools/esign/${draft.id}/self`, { fields: own, images }));
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const send = async () => {
    if (!draft) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<SignRequestInfo>(`/tools/esign/${draft.id}/send`, {
        signers: signers.map((s) => ({ name: s.name.trim(), email: s.email.trim() })), order, fields, message: message.trim() || undefined,
        mailboxId: mailboxId || undefined, expiresDays: days, remindDays: remind,
      });
      toast.success("Sent for signing");
      void qc.invalidateQueries({ queryKey: ["tools-esign"] });
      setParams({ request: r.id }, { replace: true });
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const drop = (e: DragEvent) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void begin(() => uploadPdf(f)); };
  const field = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-brand";

  if (selfDone) {
    return (
      <Card className="space-y-3 p-5" data-testid="sign-self-done">
        {selfDone.status === "completed" && selfDone.downloadUrl ? (
          <>
            <p className="font-medium">Signed</p>
            <p className="text-sm text-muted">{selfDone.title} is signed. Download it, or share it as a link.</p>
            <div className="flex flex-wrap gap-2">
              <a className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-4 text-sm font-medium text-brand-fg" href={`/api${selfDone.downloadUrl.replace(/^\/api/, "")}`} download><IconDownload className="h-4 w-4" />Download</a>
              <Button variant="outline" onClick={() => navigate("/app/tools/sign")}>Sign another</Button>
            </div>
          </>
        ) : selfDone.status === "failed" ? <p className="text-sm text-bad">{selfDone.error ?? "That didn't work. Try again."}</p> : <p className="text-sm text-muted">Placing your signature...</p>}
      </Card>
    );
  }

  if (!draft) {
    return (
      <Card className="p-5">
        <div onDragOver={(e) => e.preventDefault()} onDrop={drop} className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong px-4 py-10 text-center">
          <IconFileUp className="h-6 w-6 text-muted" />
          <p className="text-sm text-muted">{busy ? "Opening..." : "Drop a PDF here, up to 25 MB"}</p>
          <input ref={input} type="file" accept="application/pdf,.pdf" className="hidden" data-testid="sign-file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void begin(() => uploadPdf(f)); }} />
          <Button variant="outline" size="sm" onClick={() => input.current?.click()} loading={busy}>Choose a PDF</Button>
          {error && <p role="alert" className="text-sm text-bad">{error}</p>}
        </div>
      </Card>
    );
  }

  const fieldsReady = mode === "self" ? fields.length > 0 && padReady : signers.every((s, i) => s.name.trim() && /\S+@\S+\.\S+/.test(s.email) && fields.some((f) => f.signer === i && f.kind === "signature"));
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{draft.title}</span>
          {pages && <label className="ml-auto flex items-center gap-2 text-[13px] text-muted">Add fields to page
            <Select bare className="rounded-md border border-line bg-surface px-2 py-1 text-sm" value={page} onChange={(e) => setPage(Number(e.target.value))}>{pages.map((p) => <option key={p.page} value={p.page}>{p.page}</option>)}</Select></label>}
        </div>
        {!pages ? (error ? <p role="alert" className="text-sm text-bad">{error}</p> : <Skeleton className="mx-auto aspect-[1/1.41] w-full max-w-[640px]" />) : (
          <PagePlacer pages={pages} fields={fields} setFields={setFields} selected={selected} setSelected={setSelected} labelOf={labelOf} colorOf={colorOf} />
        )}
      </div>
      <aside className="space-y-4 max-lg:order-first lg:sticky lg:top-4 lg:self-start">
        <div className="flex gap-2" role="tablist" aria-label="Who signs">
          {(["self", "request"] as const).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => { setMode(m); setFields([]); setSelected(null); }}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm ${mode === m ? "border-brand bg-brand/5 font-medium" : "border-line hover:bg-hover"}`}>{m === "self" ? "Sign it myself" : "Ask others to sign"}</button>
          ))}
        </div>
        {mode === "self" ? (
          <Card className="space-y-4 p-4">
            <SignaturePad ref={pad} defaultName="" onChange={setPadReady} />
            <div className="flex flex-wrap gap-2">
              {(["signature", "initials", "date"] as const).map((k) => <Button key={k} size="sm" variant="outline" onClick={() => add(k)} disabled={!pages}><IconPlus className="h-3.5 w-3.5" />{KIND_LABEL[k]}</Button>)}
            </div>
            <p className="text-[12px] text-muted">Add a field, then drag it into place. Drag its corner to resize.</p>
            {error && <p role="alert" className="text-sm text-bad">{error}</p>}
            <Button className="w-full" onClick={signSelf} loading={busy} disabled={!fieldsReady} data-testid="sign-self"><IconPenLine className="h-4 w-4" />Sign</Button>
          </Card>
        ) : (
          <Card className="space-y-4 p-4">
            <div className="space-y-2">
              {signers.map((s, i) => (
                <div key={i} className="space-y-1.5 rounded-lg border border-line p-2.5" style={{ borderLeft: `4px solid ${SIGNER_COLORS[i % SIGNER_COLORS.length]}` }}>
                  <div className="flex items-center gap-2 text-[12px] text-muted">{order === "sequence" ? `Signs ${i + 1}${i === 0 ? "st" : i === 1 ? "nd" : i === 2 ? "rd" : "th"}` : `Signer ${i + 1}`}
                    {signers.length > 1 && <button type="button" className="ml-auto text-muted hover:text-fg" aria-label={`Remove signer ${i + 1}`} onClick={() => { setSigners(signers.filter((_, j) => j !== i)); setFields(fields.filter((f) => f.signer !== i).map((f) => (f.signer > i ? { ...f, signer: f.signer - 1 } : f))); }}><IconClose className="h-3.5 w-3.5" /></button>}</div>
                  <input className={field} placeholder="Name" value={s.name} maxLength={120} onChange={(e) => setSigners(signers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} aria-label={`Signer ${i + 1} name`} />
                  <input className={field} placeholder="Email" type="email" value={s.email} maxLength={254} onChange={(e) => setSigners(signers.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))} aria-label={`Signer ${i + 1} email`} />
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => add("signature", i)} disabled={!pages}><IconPlus className="h-3.5 w-3.5" />Signature</Button>
                    <Button size="sm" variant="ghost" onClick={() => add("date", i)} disabled={!pages}><IconPlus className="h-3.5 w-3.5" />Date</Button>
                    {v2 && <Button size="sm" variant="ghost" onClick={() => add("text", i)} disabled={!pages} data-testid="sign-add-text"><IconPlus className="h-3.5 w-3.5" />Text</Button>}
                    {v2 && <Button size="sm" variant="ghost" onClick={() => add("checkbox", i)} disabled={!pages} data-testid="sign-add-checkbox"><IconPlus className="h-3.5 w-3.5" />Checkbox</Button>}
                  </div>
                </div>
              ))}
              {signers.length < 10 && <Button size="sm" variant="ghost" onClick={() => setSigners([...signers, { name: "", email: "" }])}><IconPlus className="h-3.5 w-3.5" />Add a signer</Button>}
            </div>
            {sel && selected !== null && (sel.kind === "text" || sel.kind === "checkbox") && (
              <label className="block space-y-1 text-[13px] font-medium">What the signer sees beside this {sel.kind === "text" ? "text field" : "checkbox"}
                <input className={field} maxLength={40} value={sel.label ?? ""} placeholder={sel.kind === "text" ? "For example: Job title" : "For example: I accept the terms"} data-testid="sign-field-label"
                  onChange={(e) => setFields(fields.map((f, j) => (j === selected ? { ...f, label: e.target.value } : f)))} />
              </label>
            )}
            {signers.length > 1 && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={order === "sequence"} onChange={(e) => setOrder(e.target.checked ? "sequence" : "any")} />Sign in this order</label>}
            <label className="block space-y-1 text-[13px] font-medium">Message <span className="font-normal text-muted">(optional)</span><textarea className={field} rows={3} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} /></label>
            {!attachment && (
              <label className="block space-y-1 text-[13px] font-medium">Send from
                <Select value={mailboxId} onChange={(e) => setMailboxId(e.target.value)}>
                  <option value="">Choose a mailbox</option>
                  {(mailboxes.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.address}</option>)}
                </Select>
              </label>
            )}
            {attachment && <p className="text-[12px] text-muted">The request goes as a reply in the email thread this document came from.</p>}
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1 text-[13px] font-medium">Open for<Select value={days} onChange={(e) => setDays(Number(e.target.value))}>{[3, 7, 14, 30].map((d) => <option key={d} value={d}>{d} days</option>)}</Select></label>
              <label className="space-y-1 text-[13px] font-medium">Reminders<Select value={remind} onChange={(e) => setRemind(Number(e.target.value))}><option value={0}>None</option>{[2, 3, 7].map((d) => <option key={d} value={d}>Every {d} days</option>)}</Select></label>
            </div>
            {error && <p role="alert" className="text-sm text-bad">{error}</p>}
            <Button className="w-full" onClick={send} loading={busy} disabled={!fieldsReady || (!attachment && !mailboxId)} data-testid="sign-send"><IconSend className="h-4 w-4" />Send for signing</Button>
            {v2 && (tplName === null
              ? <Button className="w-full" variant="outline" onClick={() => setTplName(draft?.title.replace(/\.pdf$/i, "") ?? "")} disabled={!templateReady || !pages} data-testid="sign-save-template">Save as template</Button>
              : <div className="space-y-2 rounded-lg border border-line p-3">
                  <label className="block space-y-1 text-[13px] font-medium">Template name<input className={field} maxLength={80} value={tplName} autoFocus onChange={(e) => setTplName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void saveTemplate(); if (e.key === "Escape") setTplName(null); }} data-testid="sign-template-name" /></label>
                  <p className="text-[12px] text-muted">Each signer&apos;s name becomes a role, like Client or Manager. People are added when you use it.</p>
                  <div className="flex gap-2"><Button size="sm" onClick={saveTemplate} loading={busy} disabled={!tplName.trim()} data-testid="sign-template-save">Save template</Button><Button size="sm" variant="ghost" onClick={() => setTplName(null)}>Cancel</Button></div>
                </div>)}
          </Card>
        )}
        <p className="text-[12px] text-muted">{ESIGN_NOTE}</p>
      </aside>
    </div>
  );
}

const SIGNER_STATUS: Record<SignerStatus, { label: string; tone: "neutral" | "brand" | "ok" | "bad" | "warn" }> = {
  waiting: { label: "Not sent yet", tone: "neutral" }, sent: { label: "Waiting", tone: "warn" }, viewed: { label: "Viewed", tone: "brand" }, signed: { label: "Signed", tone: "ok" }, declined: { label: "Declined", tone: "bad" },
};
const REQ_STATUS: Record<SignRequestInfo["status"], { label: string; tone: "neutral" | "brand" | "ok" | "bad" | "warn" }> = {
  draft: { label: "Draft", tone: "neutral" }, preparing: { label: "Preparing", tone: "neutral" }, out: { label: "Out for signing", tone: "warn" }, finishing: { label: "Finishing", tone: "brand" },
  completed: { label: "Completed", tone: "ok" }, declined: { label: "Declined", tone: "bad" }, cancelled: { label: "Cancelled", tone: "neutral" }, expired: { label: "Expired", tone: "neutral" }, failed: { label: "Needs attention", tone: "bad" },
};

function RequestDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const [, setParams] = useSearchParams();
  const q = useQuery({ queryKey: ["tools-esign", id], queryFn: () => api.get<SignRequestInfo>(`/tools/esign/${id}`), refetchInterval: (d) => (d.state.data?.status === "finishing" ? 3000 : false) });
  const cancel = useMutation({ mutationFn: () => api.post<SignRequestInfo>(`/tools/esign/${id}/cancel`), onSuccess: () => { toast.success("Request cancelled"); void qc.invalidateQueries({ queryKey: ["tools-esign"] }); }, onError: (e) => toast.error(errorMessage(e)) });
  if (q.isLoading) return <Skeleton className="h-40 w-full" />;
  if (!q.data) return <EmptyState title="Request not found" body={errorMessage(q.error)} />;
  const r = q.data;
  const st = REQ_STATUS[r.status];
  return (
    <div className="space-y-4" data-testid="sign-request">
      <Button size="sm" variant="ghost" onClick={() => setParams({ tab: "requests" })}>Back to requests</Button>
      <Card className="space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-2"><h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{r.title}</h2><Badge tone={st.tone}>{st.label}</Badge></div>
        <p className="text-[13px] text-muted">Sent {when(r.createdAt)} · {r.orderMode === "sequence" ? "Signed in order" : "Any order"} · {r.status === "out" ? `Open until ${when(r.expiresAt)}` : r.completedAt ? `Completed ${when(r.completedAt)}` : ""}</p>
        {r.waitingOn?.length ? <p className="text-sm">Waiting on {r.waitingOn.join(", ")}</p> : null}
        {r.error && <p className="text-sm text-bad">{r.error}</p>}
        <ul className="divide-y divide-line">
          {r.signers.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
              <span className="font-medium">{s.name}</span><span className="text-muted">{s.email}</span>
              <span className="ml-auto"><Badge tone={SIGNER_STATUS[s.status].tone}>{SIGNER_STATUS[s.status].label}</Badge></span>
              {s.declineReason && <p className="w-full text-[13px] text-muted">Reason: {s.declineReason}</p>}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          {r.downloadUrl && <a className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-4 text-sm font-medium text-brand-fg" href={`/api${r.downloadUrl.replace(/^\/api/, "")}`} download><IconDownload className="h-4 w-4" />Download signed copy</a>}
          {r.recordUrl && <a className="inline-flex h-9 items-center gap-2 rounded-lg border border-line px-4 text-sm font-medium hover:bg-hover" href={`/api${r.recordUrl.replace(/^\/api/, "")}`} download data-testid="sign-record-download"><IconDownload className="h-4 w-4" />Download record</a>}
          {(r.status === "out" || r.status === "failed") && <Button variant="danger" onClick={() => cancel.mutate()} loading={cancel.isPending}>Cancel request</Button>}
        </div>
      </Card>
      <Card className="p-5">
        <h3 className="mb-2 text-[15px] font-semibold">Signing record</h3>
        {(r.v2 || r.sealed) && (
          <div className="mb-3 flex flex-wrap gap-2" data-testid="sign-v2-badges">
            {r.v2 && <Badge tone="neutral">Signers checked by email code</Badge>}
            {r.sealed && <Badge tone="ok">Sealed with workspace key {r.sealKeyId}</Badge>}
            {r.sealed && <a className="text-[12px] text-brand underline-offset-2 hover:underline" href="/sign/verify" target="_blank" rel="noopener">Check a copy</a>}
          </div>
        )}
        <p className="mb-3 text-[12px] text-muted">Fingerprint before signing (SHA-256): <span className="break-all font-mono">{r.sourceSha256}</span>{r.finalSha256 && <><br />Signed copy (SHA-256): <span className="break-all font-mono">{r.finalSha256}</span></>}</p>
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Signing record">
          <table className="w-full text-[13px]" data-testid="sign-record">
            <thead><tr className="text-left text-muted"><th className="py-1 pr-3 font-medium">Time (UTC)</th><th className="pr-3 font-medium">Name</th><th className="pr-3 font-medium">Email</th><th className="pr-3 font-medium">Action</th><th className="pr-3 font-medium">Country</th>{r.v2 && <th className="font-medium">Signer time and device</th>}</tr></thead>
            <tbody>{(r.events ?? []).map((e, i) => <tr key={i} className="border-t border-line"><td className="py-1.5 pr-3 tabular-nums">{e.at.replace("T", " ").slice(0, 19)}</td><td className="pr-3">{e.name}</td><td className="pr-3">{e.email}</td><td className="pr-3">{actionLabel(e.action)}</td><td className="pr-3">{e.ipCountry ?? ""}</td>{r.v2 && <td className="text-muted">{[localAt(e.at, e.tz), e.device].filter(Boolean).join(", ")}</td>}</tr>)}</tbody>
          </table>
        </div>
      </Card>
      <p className="text-[12px] text-muted">{ESIGN_NOTE}</p>
    </div>
  );
}

const ACTIONS: Record<string, string> = { created: "Created the request", sent: "Sent the signing link", viewed: "Opened the document", signed: "Signed", declined: "Declined", reminded: "Sent a reminder", completed: "Everyone signed", cancelled: "Cancelled", self_signed: "Signed" };
const actionLabel = (a: string) => ACTIONS[a] ?? a;

function RequestList() {
  const [, setParams] = useSearchParams();
  const q = useQuery({ queryKey: ["tools-esign"], queryFn: () => api.get<{ requests: SignRequestInfo[] }>("/tools/esign") });
  if (q.isLoading) return <Skeleton className="h-40 w-full" />;
  const list = (q.data?.requests ?? []).filter((r) => r.kind === "request");
  if (!list.length) return <EmptyState title="No signing requests yet" body="Open a PDF and choose Ask others to sign." />;
  return (
    <Card className="divide-y divide-line px-5 py-1">
      {list.map((r) => (
        <button key={r.id} type="button" onClick={() => setParams({ request: r.id })} className="block w-full py-3 text-left hover:bg-hover/40" data-testid="sign-row">
          <div className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1 truncate font-medium">{r.title}</span><Badge tone={REQ_STATUS[r.status].tone}>{REQ_STATUS[r.status].label}</Badge></div>
          <p className="mt-0.5 text-[13px] text-muted">{r.signers.filter((s) => s.status === "signed").length} of {r.signers.length} signed{r.waitingOn?.length ? ` · waiting on ${r.waitingOn.join(", ")}` : ""}{r.signers.some((s) => s.status === "declined") ? " · declined" : ""} · {when(r.createdAt)}</p>
        </button>
      ))}
    </Card>
  );
}

export function SignPage() {
  const config = useConfig();
  const [params, setParams] = useSearchParams();
  const tools = useQuery({ queryKey: ["tools"], enabled: !!config.data?.tools, queryFn: () => api.get<ToolsInfo>("/tools") });
  const on = !!tools.data?.features?.includes("esign");
  if (config.data && (!config.data.tools || (tools.data && !on))) return <EmptyState title="E-sign is not available" body="Ask your workspace admin about Tools." />;
  const request = params.get("request");
  const t = params.get("tab");
  const tab = request ? "requests" : t === "requests" ? "requests" : t === "templates" ? "templates" : "new";
  return (
    <ToolsFrame entryKey="esign" title="E-sign" description="Sign a PDF yourself, or send it for others to sign from your own mailbox." wide testId="sign-page">
      <div className="flex gap-2" role="tablist">
        {([["new", "Sign a document"], ["requests", "Requests"], ["templates", "Templates"]] as const).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setParams(k === "new" ? {} : { tab: k })} data-testid={`sign-tab-${k}`}
            className={`rounded-lg border px-3 py-1.5 text-sm ${tab === k ? "border-brand bg-brand/5 font-medium" : "border-line hover:bg-hover"}`}>{label}</button>
        ))}
      </div>
      {!on ? <Skeleton className="h-40 w-full" /> : request ? <RequestDetail id={request} /> : tab === "requests" ? <RequestList /> : tab === "templates" ? <TemplatesPanel /> : <NewDocument />}
    </ToolsFrame>
  );
}
