/**
 * TD7 Forms pro B on the public form page (FORMS_TD7): the brand kit, the closed page, the password gate, save and
 * resume with a link, and counts of views, starts and questions reached. No cookie, no storage, no outside script:
 * counts are sent from memory once per page load, and the resume link keeps its token after # so it never reaches a server log.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Field, Input } from "@/web/components/ui/input";
import { Card, CopyButton } from "@/web/components/ui/misc";
import type { Brand, ClosedReason } from "@/shared/forms-td7";

export interface Td7PublicInfo { brand: Brand; logo: boolean; saveResume: boolean; closed: ClosedReason; closedMessage: string; locked: boolean; closesAt: string | null }
interface WithTd7 { name: string; description?: string; workspace?: string; fields: { id: string }[]; td7?: Td7PublicInfo }

/** Per page load only (no storage): the password access and the resume token for each form. */
const memory = new Map<string, { access?: string; resume?: string }>();
const mem = (slug: string) => { let m = memory.get(slug); if (!m) { m = {}; memory.set(slug, m); } return m; };
/** Extra body for a public submit: the access token and the resume token, when there are any. */
/** The password access token for a form, for the upload header. */
export const td7Access = (slug: string | undefined) => (slug ? memory.get(slug)?.access : undefined);
export const td7Body = (slug: string | undefined) => { const m = slug ? memory.get(slug) : undefined; return m && (m.access || m.resume) ? { td7Access: m.access, td7Resume: m.resume } : {}; };

const send = (slug: string, kind: "view" | "start" | "reach", field?: string) => {
  // Best effort counts; a failure never shows to the person filling the form.
  void api.post(`/public/forms/${slug}/events`, field ? { kind, field } : { kind }).catch(() => undefined);
};

/** Wraps any public form renderer: brand, closed page, password gate and counts. Without TD7 it renders the children as they are. */
export function Td7Shell({ slug, form, children }: { slug: string; form: WithTd7; children: ReactNode }) {
  const t = form.td7;
  const counted = useRef<{ view: boolean; start: boolean; reached: Set<string> }>({ view: false, start: false, reached: new Set() });
  const fieldIds = new Set(form.fields.map((f) => f.id));
  // Closed is decided when the page opens: a refetch after this visitor's own answer (TD2 refreshes the form after
  // sending) must not swap their thank you for the closed page. A late send is still refused by the server with 410.
  const [closedAtOpen] = useState(() => !!form.td7?.closed);
  useEffect(() => {
    if (!t || t.closed || t.locked || counted.current.view) return;
    counted.current.view = true;
    send(slug, "view");
  }, [slug, t]);
  if (!t) return <>{children}</>;
  const onInput = (e: React.FormEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    const name = el.closest<HTMLElement>("[name]")?.getAttribute("name") ?? "";
    if (!fieldIds.has(name)) return;
    const c = counted.current;
    if (!c.start) { c.start = true; send(slug, "start"); }
    if (!c.reached.has(name)) { c.reached.add(name); send(slug, "reach", name); }
  };
  return (
    <div className="td7-brand min-h-dvh" data-brand-accent={t.brand.accent} data-brand-surface={t.brand.surface} data-brand-font={t.brand.font} data-testid="td7-brand" onInputCapture={onInput} onChangeCapture={onInput}>
      {t.logo && <div className="flex justify-center px-4 pt-8"><img src={`/api/public/forms/${slug}/logo`} alt={form.workspace ? `${form.workspace} logo` : "Logo"} className="h-10 max-w-[220px] object-contain" data-testid="td7-logo" /></div>}
      {closedAtOpen ? <ClosedPage form={form} /> : t.locked ? <PasswordGate slug={slug} form={form} /> : children}
    </div>
  );
}

function ClosedPage({ form }: { form: WithTd7 }) {
  return (
    <main className="px-4 py-10 text-fg">
      <Card className="mx-auto max-w-lg p-8 text-center" data-testid="td7-closed">
        {form.workspace && <p className="text-[12.5px] text-muted">{form.workspace}</p>}
        <h1 className="mt-1 text-xl font-semibold">{form.name}</h1>
        <p className="mt-3 whitespace-pre-wrap text-[14px] text-muted" role="status">{form.td7?.closedMessage}</p>
      </Card>
    </main>
  );
}

function PasswordGate({ slug, form }: { slug: string; form: WithTd7 }) {
  const qc = useQueryClient();
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const openForm = async () => {
    if (!pw) { setErr("Enter the password."); return; }
    setBusy(true); setErr("");
    try {
      const r = await api.post<{ access: string | null; form: WithTd7 }>(`/public/forms/${slug}/password`, { password: pw });
      if (r.access) mem(slug).access = r.access;
      qc.setQueryData(["public-form", slug], r.form);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 429)) setErr(e.message); else showError(e as Error);
    } finally { setBusy(false); }
  };
  return (
    <main className="px-4 py-10 text-fg">
      <Card className="mx-auto max-w-lg p-6 sm:p-8" data-testid="td7-locked">
        {form.workspace && <p className="text-[12.5px] text-muted">{form.workspace}</p>}
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{form.name}</h1>
        <p className="mt-2 text-[14px] text-muted">This form needs a password. Ask the person who shared it with you.</p>
        <form className="mt-6 space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); void openForm(); }}>
          <Field label="Password" error={err}>{(fp) => (<Input {...fp} type="password" name="td7-password" autoComplete="current-password" value={pw} onChange={(e) => { setPw(e.target.value); if (err) setErr(""); }} autoFocus maxLength={128} data-testid="td7-password" />)}</Field>
          <Button type="submit" className="w-full" loading={busy}>Open form</Button>
        </form>
      </Card>
    </main>
  );
}

/** Save and finish later, and picking up from a resume link. The renderer passes its answers and how to restore them. */
export function Td7SaveResume({ slug, form, answers, onRestore }: { slug: string; form: WithTd7; answers: Record<string, string | string[]>; onRestore: (a: Record<string, string | string[]>) => void }) {
  const on = !!form.td7?.saveResume && !form.td7.closed && !form.td7.locked;
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const restored = useRef(false);
  useEffect(() => {
    if (!on || restored.current) return;
    const m = window.location.hash.match(/^#resume=([A-Za-z0-9_.-]{10,200})$/);
    if (!m) return;
    restored.current = true;
    const token = m[1];
    // The token leaves the address bar at once; it stays in memory for this visit only.
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    void api.post<{ answers: Record<string, string | string[]>; expiresAt: string }>(`/public/forms/${slug}/partial/load`, { resume: token, access: mem(slug).access ?? null })
      .then((r) => { mem(slug).resume = token; onRestore(r.answers); setNote("Welcome back. Your saved answers are filled in."); })
      .catch(() => setNote("That saved link has expired or isn't valid. You can start the form again."));
  }, [on, slug, onRestore]);
  if (!on) return null;
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ resume: string; expiresAt: string }>(`/public/forms/${slug}/partial`, { answers, resume: mem(slug).resume ?? null, access: mem(slug).access ?? null });
      mem(slug).resume = r.resume;
      setLink({ url: `${window.location.origin}/f/${slug}#resume=${r.resume}`, expiresAt: r.expiresAt });
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <div className="mt-4 space-y-2" data-testid="td7-save">
      {note && <p className="text-[13px] text-muted" role="status">{note}</p>}
      <Button type="button" variant="secondary" className="w-full" onClick={() => void save()} loading={busy} data-testid="td7-save-later">Save and finish later</Button>
      <div aria-live="polite">
        {link && (
          <div className="rounded-lg border border-line p-3 text-[13px]" data-testid="td7-resume-link">
            <p>Your answers are saved. Keep this link to finish later. It works until {new Date(link.expiresAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}.</p>
            <div className="mt-2 flex items-center gap-2"><Input readOnly value={link.url} aria-label="Resume link" className="min-w-0 flex-1" onFocus={(e) => e.currentTarget.select()} /><CopyButton value={link.url} label="Copy link" /></div>
          </div>
        )}
      </div>
    </div>
  );
}
