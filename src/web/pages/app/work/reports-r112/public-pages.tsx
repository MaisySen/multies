/**
 * R112: public pages. /report/<id> (make or check an anonymous report) and /data-request/<id> (+ /verify/<token>, /download/<token>).
 * Every call here leaves without cookies (credentials "omit"); the page starts no error tracking or analytics (main.tsx), and the
 * server answers these routes without reading the client address or user agent. The case number and passphrase live only in this
 * page's memory: nothing is put in storage, the address bar or the page title.
 */
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { Button } from "@/web/components/ui/button";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { Card, Skeleton } from "@/web/components/ui/misc";
import { IconCheckCircle, IconCopy, IconDownload, IconInfo, IconLock, IconShieldCheck, IconWarning } from "@/web/components/ui/icon";
import { Logo } from "@/web/components/logo";
import { Composer, Thread, day } from "./thread";
import { REPORT_LIMITS, REPORT_STATUS_LABELS, type ReporterThread } from "@/shared/reporting-r112";

class PubError extends Error { constructor(public status: number, message: string) { super(message); } }
async function pub<T>(path: string, body?: unknown, files?: File[]): Promise<T> {
  let init: RequestInit;
  if (files?.length) {
    const fd = new FormData();
    fd.set("data", JSON.stringify(body ?? {}));
    for (const f of files) fd.append("files", f);
    init = { method: "POST", body: fd, headers: { "x-multies-upload": "1" } };
  } else init = body === undefined ? { method: "GET" } : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } };
  const res = await fetch(`/api/pub/${path}`, { ...init, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
  if (!res.ok) {
    let msg = "Something went wrong. Please try again.";
    try { msg = ((await res.json()) as { error?: { message?: string } }).error?.message ?? msg; } catch { /* not JSON */ }
    throw new PubError(res.status, msg);
  }
  return (await res.json()) as T;
}
async function pubBlob(path: string, body: unknown, name: string) {
  const res = await fetch(`/api/pub/${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
  if (!res.ok) { let msg = "That file couldn't be downloaded."; try { msg = ((await res.json()) as { error?: { message?: string } }).error?.message ?? msg; } catch { /* binary */ } throw new PubError(res.status, msg); }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function Shell({ children, workspace }: { children: React.ReactNode; workspace?: string }) {
  return (
    <main className="min-h-dvh bg-bg px-4 py-8 text-fg sm:py-12">
      <div className="mx-auto max-w-2xl space-y-5">
        {workspace && <p className="text-[12.5px] text-muted">{workspace}</p>}
        {children}
        <div className="flex items-center justify-center gap-2 pt-2 text-[12px] text-subtle">Secure page by <Logo className="h-4" /></div>
      </div>
    </main>
  );
}
function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "bad"; children: React.ReactNode }) {
  const cls = tone === "warn" ? "border-warn/30 bg-warn-soft" : tone === "bad" ? "border-bad/30 bg-bad-soft" : "border-line bg-fill";
  const Icon = tone === "info" ? IconInfo : IconWarning;
  return <div role={tone === "bad" ? "alert" : "note"} className={`flex gap-3 rounded-xl border px-4 py-3 text-[13.5px] ${cls}`}><Icon className="mt-0.5 h-4 w-4 shrink-0" /><div className="space-y-1">{children}</div></div>;
}
function Unavailable({ what }: { what: string }) {
  return <Card className="p-8 text-center"><h1 className="text-lg font-semibold">This {what} isn't available</h1><p className="mt-1 text-[13px] text-muted">The link may be wrong, or the page has been turned off.</p></Card>;
}
const Hidden = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
  <div aria-hidden="true" className="pointer-events-none absolute -left-[10000px] h-px w-px overflow-hidden"><label>Leave this empty<input type="text" name="website" tabIndex={-1} autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} /></label></div>
);

function Protections() {
  return (
    <Notice>
      <p className="font-medium">Your protections</p>
      <p>In Australia, if you are an eligible whistleblower reporting misconduct or an improper state of affairs, the law protects your identity and protects you from being treated badly because of your report (Corporations Act 2001, Part 9.4AAA, and the tax whistleblower rules). You can stay anonymous, and you can still be protected.</p>
      <p>This is general information, not legal advice. ASIC has more on <a className="underline underline-offset-2" href="https://asic.gov.au/about-asic/asic-investigations-and-enforcement/whistleblowing/" target="_blank" rel="noreferrer noopener">whistleblower protections</a>.</p>
    </Notice>
  );
}

interface ChannelInfo { workspace: string; intro: string; limits: { files: number; fileBytes: number; chars: number } }

export function PublicReportPage() {
  const { slug = "" } = useParams();
  const [info, setInfo] = useState<ChannelInfo | null | "missing">(null);
  const [mode, setMode] = useState<"start" | "write" | "check">("start");
  const [receipt, setReceipt] = useState<{ caseNo: string; passphrase: string } | null>(null);
  const [session, setSession] = useState<{ caseNo: string; token: string; thread: ReporterThread } | null>(null);
  useEffect(() => { pub<ChannelInfo>(`report/${slug}`).then(setInfo, () => setInfo("missing")); }, [slug]);
  if (info === null) return <Shell><Skeleton className="h-72" /></Shell>;
  if (info === "missing") return <Shell><Unavailable what="page" /></Shell>;
  return (
    <Shell workspace={info.workspace}>
      {session ? <ReporterView slug={slug} session={session} onSession={setSession} onLeave={() => { setSession(null); setMode("start"); }} />
        : receipt ? <Receipt receipt={receipt} onDone={() => { setReceipt(null); setMode("check"); }} />
        : mode === "write" ? <WriteReport slug={slug} info={info} onBack={() => setMode("start")} onDone={setReceipt} />
        : mode === "check" ? <CheckReport slug={slug} onBack={() => setMode("start")} onIn={setSession} />
        : (
          <>
            <header>
              <h1 className="text-2xl font-semibold tracking-tight">Make a report</h1>
              <p className="mt-2 whitespace-pre-wrap text-[14px] text-muted">{info.intro || "Tell us about something that worries you at work. You don't have to give your name."}</p>
            </header>
            <div className="grid gap-3 sm:grid-cols-2">
              <button type="button" onClick={() => setMode("write")} className="rounded-2xl border border-line bg-elevated p-5 text-left transition-colors duration-150 hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand" data-testid="report-start">
                <IconShieldCheck className="h-5 w-5" /><div className="mt-3 text-[15px] font-semibold">Make a report</div><div className="mt-1 text-[13px] text-muted">Anonymous. You get a case number and passphrase to follow up.</div>
              </button>
              <button type="button" onClick={() => setMode("check")} className="rounded-2xl border border-line bg-elevated p-5 text-left transition-colors duration-150 hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand" data-testid="report-check">
                <IconLock className="h-5 w-5" /><div className="mt-3 text-[15px] font-semibold">Check a report</div><div className="mt-1 text-[13px] text-muted">Read replies and add more with your case number and passphrase.</div>
              </button>
            </div>
            <Notice>
              <p className="font-medium">What we keep</p>
              <p>Only what you write and any files you add. This page keeps no address of your device or network, no browser details, no cookies and no tracking.</p>
            </Notice>
            <Protections />
          </>
        )}
    </Shell>
  );
}

function WriteReport({ slug, info, onBack, onDone }: { slug: string; info: ChannelInfo; onBack: () => void; onDone: (r: { caseNo: string; passphrase: string }) => void }) {
  const [f, setF] = useState({ what: "", when: "", where: "", who: "", website: "" });
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const tooBig = files.some((x) => x.size > info.limits.fileBytes);
  const ok = f.what.trim().length >= 10 && f.what.length <= info.limits.chars && !tooBig && files.length <= info.limits.files;
  const send = async () => {
    setBusy(true); setErr("");
    try { onDone(await pub<{ caseNo: string; passphrase: string }>(`report/${slug}/cases`, f, files)); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Card className="relative space-y-4 p-5 sm:p-6">
      <div><h1 className="text-xl font-semibold">Make a report</h1><p className="mt-1 text-[13px] text-muted">Don't include your name or anything that identifies you unless you want to.</p></div>
      <Hidden value={f.website} onChange={(v) => setF({ ...f, website: v })} />
      <Field label="What happened?" hint="Describe it in your own words. At least a sentence.">{(fp) => <Textarea {...fp} value={f.what} onChange={(e) => setF({ ...f, what: e.target.value })} className="min-h-40" maxLength={info.limits.chars} data-testid="report-what" />}</Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="When" hint="Optional.">{(fp) => <Input {...fp} value={f.when} maxLength={500} onChange={(e) => setF({ ...f, when: e.target.value })} placeholder="For example, last week" />}</Field>
        <Field label="Where" hint="Optional.">{(fp) => <Input {...fp} value={f.where} maxLength={500} onChange={(e) => setF({ ...f, where: e.target.value })} />}</Field>
      </div>
      <Field label="Who was involved" hint="Optional.">{(fp) => <Textarea {...fp} value={f.who} maxLength={2000} onChange={(e) => setF({ ...f, who: e.target.value })} className="min-h-20" />}</Field>
      <Field label="Files" hint={`Optional. Up to ${info.limits.files} files, ${Math.round(info.limits.fileBytes / (1024 * 1024))} MB each. Photos and documents can hold hidden details such as a name or a location; remove them first if that matters.`}>
        {(fp) => <input {...fp} type="file" multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []))} className="block w-full text-[13px] file:mr-3 file:min-h-9 file:rounded-lg file:border file:border-line file:bg-fill file:px-3 file:text-[13px]" data-testid="report-files" />}
      </Field>
      {(tooBig || files.length > info.limits.files) && <Notice tone="bad"><p>{tooBig ? `Each file can be up to ${Math.round(info.limits.fileBytes / (1024 * 1024))} MB.` : `You can add up to ${info.limits.files} files.`}</p></Notice>}
      {err && <Notice tone="bad"><p>{err}</p></Notice>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onBack}>Back</Button>
        <Button onClick={() => void send()} loading={busy} disabled={!ok} data-testid="report-send">Send report</Button>
      </div>
    </Card>
  );
}

function Receipt({ receipt, onDone }: { receipt: { caseNo: string; passphrase: string }; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const [kept, setKept] = useState(false);
  const text = `Case number: ${receipt.caseNo}\nPassphrase: ${receipt.passphrase}`;
  const copy = async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); } };
  const save = () => {
    const url = URL.createObjectURL(new Blob([`${text}\n\nKeep this safe. It cannot be shown again or recovered.\n`], { type: "text/plain" }));
    const a = document.createElement("a"); a.href = url; a.download = "my-report.txt"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  return (
    <Card className="space-y-4 p-5 sm:p-6" data-testid="report-receipt">
      <div className="flex items-center gap-2 text-ok"><IconCheckCircle className="h-5 w-5" /><h1 className="text-xl font-semibold text-fg">Your report was sent</h1></div>
      <p className="text-[14px] text-muted">Use these to check for replies and to add more. You can come back any time.</p>
      <dl className="grid gap-3 rounded-xl border border-line bg-fill p-4 sm:grid-cols-2">
        <div><dt className="text-[12px] text-muted">Case number</dt><dd className="mt-1 select-all font-mono text-[18px] font-semibold tracking-wide" data-testid="receipt-case">{receipt.caseNo}</dd></div>
        <div><dt className="text-[12px] text-muted">Passphrase</dt><dd className="mt-1 select-all break-all font-mono text-[18px] font-semibold tracking-wide" data-testid="receipt-pass">{receipt.passphrase}</dd></div>
      </dl>
      <Notice tone="warn"><p className="font-medium">Save these now. We can't show them again or recover them.</p><p>Nobody here can see your passphrase, so nobody can reset it for you.</p></Notice>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => void copy()} data-testid="receipt-copy"><IconCopy className="h-4 w-4" />{copied ? "Copied" : "Copy both"}</Button>
        <Button variant="secondary" onClick={save}><IconDownload className="h-4 w-4" />Save as a file</Button>
      </div>
      <label className="flex min-h-11 items-center gap-2 text-[14px]"><input type="checkbox" checked={kept} onChange={(e) => setKept(e.target.checked)} className="h-4 w-4 accent-brand" data-testid="receipt-kept" />I have saved my case number and passphrase</label>
      <div className="flex justify-end"><Button onClick={onDone} disabled={!kept} data-testid="receipt-done">Done</Button></div>
    </Card>
  );
}

function CheckReport({ slug, onBack, onIn }: { slug: string; onBack: () => void; onIn: (s: { caseNo: string; token: string; thread: ReporterThread }) => void }) {
  const [caseNo, setCaseNo] = useState("");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const go = async () => {
    setBusy(true); setErr("");
    try { const r = await pub<{ token: string; caseNo: string; thread: ReporterThread }>(`report/${slug}/login`, { caseNo, passphrase: pass }); setPass(""); onIn({ caseNo: r.caseNo, token: r.token, thread: r.thread }); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Card className="space-y-4 p-5 sm:p-6">
      <div><h1 className="text-xl font-semibold">Check a report</h1><p className="mt-1 text-[13px] text-muted">Enter the case number and passphrase you saved.</p></div>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (caseNo.trim() && pass.trim()) void go(); }}>
        <Field label="Case number">{(fp) => <Input {...fp} value={caseNo} onChange={(e) => setCaseNo(e.target.value)} autoComplete="off" spellCheck={false} placeholder="RC-XXXX-XXXX" className="font-mono" data-testid="check-case" />}</Field>
        <Field label="Passphrase">{(fp) => <Input {...fp} type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" data-testid="check-pass" />}</Field>
        {err && <Notice tone="bad"><p data-testid="check-error">{err}</p></Notice>}
        <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="ghost" onClick={onBack}>Back</Button><Button type="submit" loading={busy} disabled={!caseNo.trim() || !pass.trim()} data-testid="check-go">Open report</Button></div>
      </form>
    </Card>
  );
}

function ReporterView({ slug, session, onSession, onLeave }: { slug: string; session: { caseNo: string; token: string; thread: ReporterThread }; onSession: (s: { caseNo: string; token: string; thread: ReporterThread }) => void; onLeave: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const t = session.thread;
  const signedOut = (e: unknown) => e instanceof PubError && e.status === 401;
  const reply = async (text: string, files: File[]) => {
    setBusy(true); setErr("");
    try { const r = await pub<{ thread: ReporterThread }>(`report/${slug}/reply`, { caseNo: session.caseNo, token: session.token, text }, files); onSession({ ...session, thread: r.thread }); return true; }
    catch (e) { if (signedOut(e)) onLeave(); setErr((e as Error).message); return false; } finally { setBusy(false); }
  };
  const refresh = async () => {
    try { const r = await pub<{ thread: ReporterThread }>(`report/${slug}/thread`, { caseNo: session.caseNo, token: session.token }); onSession({ ...session, thread: r.thread }); }
    catch (e) { if (signedOut(e)) onLeave(); else setErr((e as Error).message); }
  };
  const file = (fileId: string, name: string) => { pubBlob(`report/${slug}/file`, { caseNo: session.caseNo, token: session.token, fileId }, name).catch((e) => setErr((e as Error).message)); };
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-mono text-xl font-semibold" data-testid="reporter-case">{t.caseNo}</h1>
          <p className="mt-1 text-[13px] text-muted">Sent {day(t.createdAt)} · Status: <span className="font-medium text-fg" data-testid="reporter-status">{REPORT_STATUS_LABELS[t.status]}</span>{t.acknowledgedAt ? ` · Received ${day(t.acknowledgedAt)}` : ""}</p>
        </div>
        <div className="flex gap-2"><Button variant="secondary" size="sm" onClick={() => void refresh()}>Check for replies</Button><Button variant="ghost" size="sm" onClick={onLeave} data-testid="reporter-leave">Leave</Button></div>
      </header>
      {t.status === "closed" && t.outcome && <Notice><p className="font-medium">Outcome</p><p className="whitespace-pre-wrap">{t.outcome}</p></Notice>}
      <Thread messages={t.messages} viewer="reporter" onFile={file} />
      {err && <Notice tone="bad"><p>{err}</p></Notice>}
      <Composer onSend={(text, files) => reply(text, files)} busy={busy} placeholder="Write a reply or add more details" />
      <p className="text-[12px] text-subtle">You are signed in to this report for {REPORT_LIMITS.readerMs / 60_000} minutes. Leave when you are done, especially on a shared device.</p>
    </div>
  );
}

// ------------------------------------------------------------------ data requests

export function PublicDataRequestPage() {
  const { slug = "" } = useParams();
  const [info, setInfo] = useState<{ workspace: string; dueDays: number } | null | "missing">(null);
  const [f, setF] = useState({ email: "", type: "export" as "export" | "delete", website: "" });
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { pub<{ workspace: string; dueDays: number }>(`data-request/${slug}`).then(setInfo, () => setInfo("missing")); }, [slug]);
  if (info === null) return <Shell><Skeleton className="h-64" /></Shell>;
  if (info === "missing") return <Shell><Unavailable what="page" /></Shell>;
  const send = async () => { setBusy(true); setErr(""); try { await pub(`data-request/${slug}`, f); setSent(true); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  return (
    <Shell workspace={info.workspace}>
      <Card className="relative space-y-4 p-5 sm:p-6">
        {sent ? (
          <div className="space-y-2" data-testid="dr-sent"><div className="flex items-center gap-2"><IconCheckCircle className="h-5 w-5 text-ok" /><h1 className="text-xl font-semibold">Check your email</h1></div>
            <p className="text-[14px] text-muted">We sent a link to {f.email}. Open it within 48 hours to confirm the request. Nothing happens until you do.</p></div>
        ) : (
          <>
            <div><h1 className="text-xl font-semibold">Ask about your data</h1><p className="mt-1 text-[13px] text-muted">Ask {info.workspace} for a copy of the data it holds about you in contacts, form answers and bookings, or ask for it to be deleted. We answer within {info.dueDays} days.</p></div>
            <Hidden value={f.website} onChange={(v) => setF({ ...f, website: v })} />
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <Field label="Your email" hint="We match your data by this address and send a link to confirm it's yours.">{(fp) => <Input {...fp} type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} data-testid="dr-email" />}</Field>
              <Field label="What would you like?">{(fp) => (
                <Select {...fp} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as "export" | "delete" })} data-testid="dr-type">
                  <option value="export">A copy of my data</option>
                  <option value="delete">Delete my data</option>
                </Select>
              )}</Field>
              {err && <Notice tone="bad"><p>{err}</p></Notice>}
              <div className="flex justify-end"><Button type="submit" loading={busy} disabled={!/^\S+@\S+\.\S+$/.test(f.email.trim())} data-testid="dr-send">Send request</Button></div>
            </form>
          </>
        )}
      </Card>
    </Shell>
  );
}

export function DataRequestVerifyPage() {
  const { token = "" } = useParams();
  const [state, setState] = useState<{ ok: true; workspace: string; type: string } | { ok: false; msg: string } | null>(null);
  useEffect(() => { pub<{ workspace: string; type: string }>("data-request/verify", { token }).then((r) => setState({ ok: true, ...r }), (e) => setState({ ok: false, msg: (e as Error).message })); }, [token]);
  return (
    <Shell>
      <Card className="space-y-2 p-6" data-testid="dr-verify">
        {!state ? <Skeleton className="h-16" /> : state.ok ? (
          <><div className="flex items-center gap-2"><IconCheckCircle className="h-5 w-5 text-ok" /><h1 className="text-xl font-semibold">Request confirmed</h1></div>
            <p className="text-[14px] text-muted">{state.workspace} will {state.type === "export" ? "send you a copy of your data" : "delete your data"} and email you when it's done.</p></>
        ) : <><h1 className="text-xl font-semibold">This link didn't work</h1><p className="text-[14px] text-muted">{state.msg}</p></>}
      </Card>
    </Shell>
  );
}

export function DataRequestDownloadPage() {
  const { token = "" } = useParams();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const get = async () => { setBusy(true); setMsg(""); try { await pubBlob("data-request/download", { token }, "my-data.zip"); setMsg("Your download has started."); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); } };
  return (
    <Shell>
      <Card className="space-y-3 p-6">
        <h1 className="text-xl font-semibold">Your data</h1>
        <p className="text-[14px] text-muted">A ZIP file with your data as JSON and CSV tables.</p>
        <Button onClick={() => void get()} loading={busy} data-testid="dr-download"><IconDownload className="h-4 w-4" />Download my data</Button>
        {msg && <p role="status" className="text-[13px] text-muted">{msg}</p>}
      </Card>
    </Shell>
  );
}
