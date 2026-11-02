/**
 * R130: Settings, Workspace, Tours (flag TOURS_R130, owners and admins). Build short tours for a page: pick each
 * element on the page itself (stable ids, never CSS paths), write the words, choose who sees it, preview, publish.
 * Members never reach this page's data: every route checks the role on the server.
 */
import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { useConfig } from "@/web/lib/queries";
import { Button } from "@/web/components/ui/button";
import { Badge, Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select } from "@/web/components/ui/input";
import { IconArrowDown, IconArrowUp, IconTrash } from "@/web/components/ui/icons";
import { SECTIONS_P2 } from "@/shared/nav-menu";
import { AUDIENCES, BUILTIN_TOURS, MAX_STEPS, PagePath, type AdminTour, type Audience, type TourStep } from "@/shared/tours-r130";
import { beginPick, beginPreview, startTour } from "@/web/components/tours-r130";

const adminKey = ["tours-r130", "admin"] as const;
type AdminList = { tours: AdminTour[]; people: { userId: string; name: string }[] };
const AUDIENCE_LABEL: Record<Audience, string> = { all: "Everyone", admins: "Admins", members: "Members" };

/** The app's own pages, from the one menu model, plus Home. */
function usePages() {
  return useMemo(() => {
    const seen = new Set<string>(); const out: { to: string; label: string }[] = [{ to: "/app", label: "Home, Overview" }, { to: "/app/my-work", label: "Home, My Work" }];
    out.forEach((p) => seen.add(p.to));
    for (const s of SECTIONS_P2) for (const p of s.pages) {
      if (seen.has(p.to) || !PagePath.safeParse(p.to).success) continue;
      seen.add(p.to); out.push({ to: p.to, label: s.label === p.label ? p.label : `${s.label}, ${p.label}` });
    }
    return out;
  }, []);
}

export function ToursSettings() {
  const config = useConfig();
  const [params, setParams] = useSearchParams();
  const editId = params.get("edit");
  const q = useQuery({ queryKey: adminKey, enabled: !!config.data?.toursR130, queryFn: () => api.get<AdminList>("/tours/admin"), retry: false });
  const [creating, setCreating] = useState(false);
  if (!config.data?.toursR130 || (q.error instanceof ApiError && q.error.status === 404)) {
    return <EmptyState title="Tours are not on for this workspace" body="Ask the person who runs Multies for your team." />;
  }
  if (q.error instanceof ApiError && q.error.status === 403) return <EmptyState title="Only admins build tours" body="Ask a workspace admin if you want a tour for your team." />;
  if (q.error) return <Card className="p-5"><p className="text-sm">Tours did not load.</p><Button className="mt-3" variant="secondary" size="sm" onClick={() => q.refetch()}>Try again</Button></Card>;
  if (q.isPending) return <div className="space-y-3" aria-busy="true"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div>;
  const editing = editId ? q.data.tours.find((t) => t.id === editId) : null;
  if (editing) return <TourEditor key={editing.id + editing.updatedAt} tour={editing} onBack={() => setParams({})} />;
  return (
    <div className="space-y-6" data-testid="tours-settings">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-prose text-[13.5px] text-muted">Short step by step tours that point at parts of a page. Each person sees a published tour once, the first time they open its page.</p>
        <Button onClick={() => setCreating(true)} data-testid="tours-new">New tour</Button>
      </div>
      {q.data.tours.length === 0 ? (
        <EmptyState title="No tours yet" body="Make one for a page your team finds confusing. It takes a minute." action={<Button variant="secondary" onClick={() => setCreating(true)}>New tour</Button>} />
      ) : (
        <ul className="space-y-2" data-testid="tours-rows">{q.data.tours.map((t) => <TourRow key={t.id} tour={t} people={q.data.people} />)}</ul>
      )}
      <section aria-labelledby="builtin-title">
        <h2 id="builtin-title" className="mb-2 text-sm font-semibold">Built in tours</h2>
        <Card className="divide-y divide-line">
          {BUILTIN_TOURS.map((t) => (
            <div key={t.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1"><p className="text-[13.5px] font-medium">{t.name}</p><p className="text-[12.5px] text-muted">{t.phoneOnly ? "Phones only. " : ""}{`${t.steps.length} steps. Started from the account menu, Tours.`}</p></div>
            </div>
          ))}
        </Card>
      </section>
      <NewTourDialog open={creating} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setParams({ edit: id }); }} />
    </div>
  );
}

function NewTourDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const pages = usePages();
  const qc = useQueryClient();
  const [name, setName] = useState(""); const [page, setPage] = useState("/app/tasks");
  const create = useMutation({
    mutationFn: () => api.create<AdminTour>("/tours/admin", { name: name.trim() || "New tour", page, audience: "all", newDays: null, steps: [] }),
    onSuccess: async (t) => { await qc.invalidateQueries({ queryKey: adminKey }); setName(""); onCreated(t.id); },
    onError: showError,
  });
  return (
    <Dialog open={open} onClose={onClose} title="New tour" description="Name it and pick its page. You add the steps next."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => create.mutate()} disabled={create.isPending} data-testid="tours-create">Create tour</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <Field label="Name">{(fp) => <Input {...fp} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Welcome to Tasks" data-testid="tours-name" autoFocus />}</Field>
        <Field label="Page">{(fp) => <Select {...fp} value={page} onChange={(e) => setPage(e.target.value)} data-testid="tours-page">{pages.map((p) => <option key={p.to} value={p.to}>{p.label}</option>)}</Select>}</Field>
      </form>
    </Dialog>
  );
}

function useTourPatch(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: Partial<AdminTour>) => api.patch<AdminTour>(`/tours/admin/${encodeURIComponent(id)}`, p),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKey }),
    onError: showError,
  });
}
function audienceText(t: AdminTour) { return `${AUDIENCE_LABEL[t.audience]}${t.newDays ? `, joined in the last ${t.newDays} days` : ""}`; }

function TourRow({ tour, people }: { tour: AdminTour; people: AdminList["people"] }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const patch = useTourPatch(tour.id);
  const pages = usePages();
  const [confirm, setConfirm] = useState(false);
  const [reset, setReset] = useState(false);
  const del = useMutation({
    mutationFn: () => api.del(`/tours/admin/${encodeURIComponent(tour.id)}`),
    onSuccess: () => { setConfirm(false); toast("Tour deleted"); void qc.invalidateQueries({ queryKey: adminKey }); },
    onError: showError,
  });
  const pageLabel = pages.find((p) => p.to === tour.page)?.label ?? tour.page;
  return (
    <li>
      <Card className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid={`tour-row-${tour.id}`}>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[14px] font-medium"><span className="truncate">{tour.name}</span>
            <Badge tone={tour.status === "published" ? "ok" : "neutral"}>{tour.status === "published" ? "Published" : "Draft"}</Badge></p>
          <p className="text-[12.5px] text-muted">{`${pageLabel} · ${audienceText(tour)} · ${tour.steps.length} ${tour.steps.length === 1 ? "step" : "steps"}`}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => navigate(`/app/settings/tours?edit=${encodeURIComponent(tour.id)}`)} data-testid="tour-edit">Edit</Button>
          <Button size="sm" variant="secondary" disabled={!tour.steps.length} onClick={() => { beginPreview(tour.id); navigate(tour.page); }} data-testid="tour-preview">Preview</Button>
          <Button size="sm" variant={tour.status === "published" ? "secondary" : "primary"} disabled={!tour.steps.length || patch.isPending}
            onClick={() => patch.mutate({ status: tour.status === "published" ? "draft" : "published" }, { onSuccess: (t) => toast(t.status === "published" ? "Tour published" : "Tour moved to drafts") })} data-testid="tour-publish">
            {tour.status === "published" ? "Unpublish" : "Publish"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setReset(true)} data-testid="tour-reset">Show again</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(true)} aria-label={`Delete ${tour.name}`} data-testid="tour-delete"><IconTrash className="h-4 w-4" aria-hidden /></Button>
        </div>
      </Card>
      <Dialog open={confirm} onClose={() => setConfirm(false)} title="Delete this tour?" description="People who have not seen it yet will not see it. This cannot be undone."
        footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button><Button variant="danger" onClick={() => del.mutate()} disabled={del.isPending} data-testid="tour-delete-confirm">Delete tour</Button></>} />
      <ResetDialog open={reset} onClose={() => setReset(false)} tour={tour} people={people} />
    </li>
  );
}

function ResetDialog({ open, onClose, tour, people }: { open: boolean; onClose: () => void; tour: AdminTour; people: AdminList["people"] }) {
  const [who, setWho] = useState(""); const [all, setAll] = useState(false);
  const reset = useMutation({
    mutationFn: () => api.post<{ cleared: number }>(`/tours/admin/reset/${encodeURIComponent(who)}`, { tourId: all ? null : tour.id }),
    onSuccess: () => { toast("They will see it again next time they open the page"); onClose(); },
    onError: showError,
  });
  return (
    <Dialog open={open} onClose={onClose} title="Show again for a person" description="Clears what they have seen, so the tour starts again on their next visit."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => reset.mutate()} disabled={!who || reset.isPending} data-testid="tour-reset-confirm">Show again</Button></>}>
      <div className="space-y-3">
        <Field label="Person">{(fp) => <Select {...fp} value={who} onChange={(e) => setWho(e.target.value)} data-testid="tour-reset-person"><option value="">Choose a person</option>{people.map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}</Select>}</Field>
        <label className="flex min-h-11 items-center gap-2 text-[13.5px]"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} className="h-4 w-4 accent-brand" />Every tour, not only this one</label>
      </div>
    </Dialog>
  );
}

function TourEditor({ tour, onBack }: { tour: AdminTour; onBack: () => void }) {
  const pages = usePages();
  const navigate = useNavigate();
  const patch = useTourPatch(tour.id);
  const [name, setName] = useState(tour.name); const [page, setPage] = useState(tour.page);
  const [audience, setAudience] = useState<Audience>(tour.audience); const [days, setDays] = useState<string>(tour.newDays ? String(tour.newDays) : "");
  const [steps, setSteps] = useState<TourStep[]>(tour.steps);
  const dirty = name !== tour.name || page !== tour.page || audience !== tour.audience || days !== (tour.newDays ? String(tour.newDays) : "") || JSON.stringify(steps) !== JSON.stringify(tour.steps);
  const n = Number(days);
  const daysOk = days === "" || (Number.isInteger(n) && n >= 1 && n <= 365);
  const body = () => ({ name, page, audience, newDays: days ? n : null, steps });
  const save = (then?: () => void) => patch.mutate(body(), { onSuccess: () => { toast("Tour saved"); then?.(); } });
  const pick = (index: number) => {
    const go = () => { beginPick({ tourId: tour.id, index }); navigate(page); };
    if (dirty) save(go); else go();
  };
  const move = (i: number, d: -1 | 1) => setSteps((s) => { const c = [...s]; const [x] = c.splice(i, 1); c.splice(i + d, 0, x!); return c; });
  const edit = (i: number, p: Partial<TourStep>) => setSteps((s) => s.map((x, k) => (k === i ? { ...x, ...p } : x)));
  return (
    <div className="space-y-5" data-testid="tour-editor">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} data-testid="tour-editor-back">Back to tours</Button>
        <span className="ml-auto" />
        <Badge tone={tour.status === "published" ? "ok" : "neutral"}>{tour.status === "published" ? "Published" : "Draft"}</Badge>
      </div>
      <Card className="grid gap-4 p-5 md:grid-cols-2">
        <Field label="Name">{(fp) => <Input {...fp} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} data-testid="tour-name" />}</Field>
        <Field label="Page">{(fp) => <Select {...fp} value={page} onChange={(e) => setPage(e.target.value)} data-testid="tour-page">{pages.map((p) => <option key={p.to} value={p.to}>{p.label}</option>)}</Select>}</Field>
        <Field label="Who sees it">{(fp) => <Select {...fp} value={audience} onChange={(e) => setAudience(e.target.value as Audience)} data-testid="tour-audience">{AUDIENCES.map((a) => <option key={a} value={a}>{AUDIENCE_LABEL[a]}</option>)}</Select>}</Field>
        <Field label="Only people who joined in the last" hint="Days. Leave empty for everyone." error={daysOk ? undefined : "Use a number from 1 to 365."}>{(fp) => <Input {...fp} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))} placeholder="Any time" data-testid="tour-days" />
        }</Field>
      </Card>
      <section aria-labelledby="steps-title" className="space-y-2">
        <div className="flex items-center gap-2">
          <h2 id="steps-title" className="text-sm font-semibold">Steps</h2>
          <span className="text-[12.5px] text-muted">{`${steps.length} of ${MAX_STEPS}`}</span>
        </div>
        {steps.length === 0 && <EmptyState title="No steps yet" body="Add a step, then click the part of the page it should point at." />}
        <ol className="space-y-2">
          {steps.map((s, i) => (
            <li key={i}>
              <Card className="space-y-3 p-4" data-testid={`tour-step-${i}`}>
                <div className="flex items-center gap-2">
                  <span className="grid h-6 w-6 place-items-center rounded-full bg-fill text-[12px] font-semibold" aria-hidden>{i + 1}</span>
                  <p className="min-w-0 flex-1 truncate text-[12.5px] text-muted">Points at <span className="font-mono text-fg">{s.target}</span></p>
                  <Button size="sm" variant="ghost" onClick={() => pick(i)} disabled={!daysOk}>Pick again</Button>
                  <Button size="sm" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move step ${i + 1} up`}><IconArrowUp className="h-4 w-4" aria-hidden /></Button>
                  <Button size="sm" variant="ghost" onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label={`Move step ${i + 1} down`}><IconArrowDown className="h-4 w-4" aria-hidden /></Button>
                  <Button size="sm" variant="ghost" onClick={() => setSteps((x) => x.filter((_, k) => k !== i))} aria-label={`Remove step ${i + 1}`}><IconTrash className="h-4 w-4" aria-hidden /></Button>
                </div>
                <Field label="Title">{(fp) => <Input {...fp} value={s.title} onChange={(e) => edit(i, { title: e.target.value })} maxLength={80} data-testid={`tour-step-title-${i}`} />}</Field>
                <Field label="Text">{(fp) => <textarea {...fp} value={s.body} onChange={(e) => edit(i, { body: e.target.value })} maxLength={400} rows={2} data-testid={`tour-step-body-${i}`}
                  className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-[14px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60" />}</Field>
              </Card>
            </li>
          ))}
        </ol>
        <Button variant="secondary" onClick={() => pick(steps.length)} disabled={steps.length >= MAX_STEPS || !daysOk} data-testid="tour-add-step">Add step</Button>
      </section>
      <div className="flex flex-wrap gap-2 border-t border-line pt-4">
        <Button onClick={() => save()} disabled={!dirty || !daysOk || patch.isPending || steps.some((s) => !s.title.trim())} data-testid="tour-save">Save</Button>
        <Button variant="secondary" disabled={!steps.length || dirty} onClick={() => { beginPreview(tour.id); navigate(page); }} data-testid="tour-editor-preview">Preview</Button>
        <Button variant="secondary" disabled={!steps.length || dirty || patch.isPending}
          onClick={() => patch.mutate({ status: tour.status === "published" ? "draft" : "published" }, { onSuccess: (t) => toast(t.status === "published" ? "Tour published" : "Tour moved to drafts") })} data-testid="tour-editor-publish">
          {tour.status === "published" ? "Unpublish" : "Publish"}
        </Button>
        {dirty && <p className="self-center text-[12.5px] text-muted">Save to preview or publish.</p>}
      </div>
    </div>
  );
}

export { startTour };
