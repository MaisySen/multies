/** R126 People: a staff profile, an asset page (where a QR label lands) and the label print sheet. */
import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { quickRetry } from "@/web/lib/quick-retry-pol1";
import { api, ApiError, errorMessage } from "@/web/lib/api";
import { useConfig } from "@/web/lib/queries";
import { cn } from "@/web/lib/cn";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { DateInput, Field, Input, Select } from "@/web/components/ui/input";
import { Avatar, Badge, Card, EmptyState, Meter, Skeleton } from "@/web/components/ui/misc";
import { LoadError } from "@/web/components/load-error-t1g";
import { useDialogs } from "@/web/components/ui/confirm";
import { QrCode } from "@/web/components/qr";
import { IconArrowLeft, IconDownload, IconEdit, IconMail, IconMapPin, IconPhone, IconPlus, IconTrash } from "@/web/components/ui/icon";
import { DaysOffPicker, daysOffText } from "@/web/pages/app/work/schedule-days-off-r39";
import { ASSET_KIND_LABEL, cleanTags, type Asset, type OnboardingTemplate, type StaffPerson } from "@/shared/people-r126";
import { assetUrl, fmtDate, getAsset, getAssets, getProfile, getStaff, getTemplates, money, pk, todayYmd, type Profile } from "./model";
import { AssetFormDialog, downloadPng, downloadSvg } from "./asset-dialogs";
import { PeopleOff, StatusBadge } from "./staff";

const notFoundOr = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 403);

function Back({ to, label }: { to: string; label: string }) {
  return <Link to={to} className="mb-2 inline-flex min-h-9 items-center gap-1 text-[13px] text-muted hover:text-fg"><IconArrowLeft className="h-4 w-4" aria-hidden="true" />{label}</Link>;
}
function Section({ title, action, children, testId }: { title: string; action?: React.ReactNode; children: React.ReactNode; testId?: string }) {
  return (
    <Card className="p-4" data-testid={testId}>
      <div className="mb-3 flex items-center gap-2"><h2 className="text-[15px] font-semibold text-fg">{title}</h2><span className="ml-auto">{action}</span></div>
      {children}
    </Card>
  );
}

export function StaffProfilePage() {
  const { userId = "" } = useParams();
  const config = useConfig();
  const on = !!config.data?.peopleR126;
  const q = useQuery({ queryKey: pk.profile(userId), queryFn: () => getProfile(userId), enabled: on, ...quickRetry });
  const [editing, setEditing] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [awayOpen, setAwayOpen] = useState(false);
  const qc = useQueryClient();
  if (config.data && !on) return <PeopleOff />;
  if (q.isError && notFoundOr(q.error)) return <EmptyState title="Profile not found" body="This person isn't in your workspace, or you can't see this page." action={<Link to="/app/contacts/staff" className="text-sm font-medium text-brand hover:underline">Back to Staff</Link>} />;
  if (q.isError && !q.data) return <LoadError onRetry={() => q.refetch()} />;
  if (!q.data) return <div className="mx-auto max-w-4xl space-y-3" aria-busy="true" aria-label="Loading profile"><Skeleton className="h-24 rounded-xl" /><Skeleton className="h-40 rounded-xl" /><Skeleton className="h-40 rounded-xl" /></div>;
  const { person: p, manager, reports, away, runs, assets, canEdit, canAdmin } = q.data;
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: pk.profile(userId) }), qc.invalidateQueries({ queryKey: pk.staff })]);
  const removeAway = async (id: string) => {
    try { await api.del(`/people/away/${encodeURIComponent(id)}`); await refresh(); await qc.invalidateQueries({ queryKey: ["people-r126", "away"] }); toast.success("Time away removed"); }
    catch (e) { toast.error(errorMessage(e)); }
  };
  const removeRun = async (id: string) => {
    try { await api.del(`/people/runs/${encodeURIComponent(id)}`); await refresh(); toast.success("Checklist removed. Its tasks stay in Tasks."); }
    catch (e) { toast.error(errorMessage(e)); }
  };
  return (
    <div className="mx-auto w-full max-w-4xl" data-testid="staff-profile">
      <Back to="/app/contacts/staff" label="Staff" />
      <div className="mb-4 flex flex-wrap items-start gap-4">
        <Avatar label={p.name} className="h-14 w-14 shrink-0 text-lg" />
        <div className="min-w-0 flex-1">
          <h1 className="break-words text-[22px] font-semibold tracking-[-0.01em] text-fg">{p.name}</h1>
          <p className="break-words text-[14px] text-muted">{[p.title, p.team].filter(Boolean).join(" · ") || "No title yet"}</p>
          {manager && <p className="text-[13px] text-subtle">Reports to <Link className="text-fg hover:underline" to={`/app/contacts/staff/${encodeURIComponent(manager.userId)}`}>{manager.name}</Link></p>}
        </div>
        {canEdit && <Button variant="secondary" size="sm" onClick={() => setEditing(true)} data-testid="profile-edit"><IconEdit className="h-4 w-4" aria-hidden="true" />Edit profile</Button>}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Section title="About">
          <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-2 text-[13.5px]">
            <dt className="text-muted">Start date</dt><dd className="text-fg">{fmtDate(p.startDate) || "Not set"}</dd>
            <dt className="text-muted">Days off</dt><dd className="text-fg">{daysOffText(p.daysOff)}</dd>
            <dt className="text-muted">Skills</dt><dd className="flex flex-wrap gap-1">{p.skills.length ? p.skills.map((s) => <Badge key={s}>{s}</Badge>) : <span className="text-subtle">None added</span>}</dd>
            {!!reports.length && <><dt className="text-muted">Team</dt><dd className="space-y-0.5">{reports.map((r) => <Link key={r.userId} to={`/app/contacts/staff/${encodeURIComponent(r.userId)}`} className="block truncate text-fg hover:underline">{r.name}</Link>)}</dd></>}
          </dl>
        </Section>
        <Section title="Contact">
          <ul className="space-y-2 text-[13.5px]">
            <li className="flex items-center gap-2 break-all"><IconMail className="h-4 w-4 shrink-0 text-subtle" aria-hidden="true" /><a href={`mailto:${p.email}`} className="text-fg hover:underline">{p.email}</a></li>
            <li className="flex items-center gap-2"><IconPhone className="h-4 w-4 shrink-0 text-subtle" aria-hidden="true" />{p.phone ? <a href={`tel:${p.phone.replace(/\s/g, "")}`} className="text-fg hover:underline">{p.phone}</a> : <span className="text-subtle">No phone added</span>}</li>
            <li className="flex items-center gap-2"><IconMapPin className="h-4 w-4 shrink-0 text-subtle" aria-hidden="true" />{p.location || <span className="text-subtle">No location added</span>}</li>
          </ul>
        </Section>
        <Section title="Time away" testId="profile-away" action={canEdit && <Button size="sm" variant="secondary" onClick={() => setAwayOpen(true)} data-testid="away-add"><IconPlus className="h-4 w-4" aria-hidden="true" />Add</Button>}>
          {!away.length ? <p className="text-[13px] text-muted">No time away planned.</p> : (
            <ul className="divide-y divide-line">{away.map((a) => (
              <li key={a.id} className="flex items-center gap-2 py-2 text-[13.5px]">
                <span className="min-w-0 flex-1"><span className="text-fg">{a.startDate === a.endDate ? fmtDate(a.startDate) : `${fmtDate(a.startDate)} to ${fmtDate(a.endDate)}`}</span>{a.note && <span className="block truncate text-muted">{a.note}</span>}</span>
                {canEdit && <Button size="icon" variant="ghost" aria-label={`Remove time away from ${fmtDate(a.startDate)}`} onClick={() => void removeAway(a.id)}><IconTrash className="h-4 w-4" aria-hidden="true" /></Button>}
              </li>))}
            </ul>
          )}
        </Section>
        <Section title="Equipment" testId="profile-assets">
          {!assets.length ? <p className="text-[13px] text-muted">No equipment assigned.</p> : (
            <ul className="divide-y divide-line">{assets.map((a) => (
              <li key={a.id} className="py-2 text-[13.5px]"><Link to={`/app/contacts/assets/${encodeURIComponent(a.id)}`} className="flex items-center gap-2 hover:underline">
                <span className="font-mono text-[12px] text-subtle">{a.tag}</span><span className="min-w-0 flex-1 truncate text-fg">{a.name}</span><span className="text-muted">{ASSET_KIND_LABEL[a.kind]}</span></Link></li>))}
            </ul>
          )}
        </Section>
        <div className="md:col-span-2">
          <Section title="Onboarding and offboarding" testId="profile-runs" action={canAdmin && <Button size="sm" variant="secondary" onClick={() => setAssigning(true)} data-testid="run-assign">Assign checklist</Button>}>
            {!runs.length ? <p className="text-[13px] text-muted">{canAdmin ? "Assign a checklist to create this person's tasks, due from their start date." : "No checklist assigned."}</p> : (
              <div className="space-y-4">{runs.map((r) => (
                <div key={r.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-fg">{r.name}</span><Badge tone={r.kind === "onboarding" ? "brand" : "neutral"}>{r.kind === "onboarding" ? "Onboarding" : "Offboarding"}</Badge>
                    <span className="text-[12.5px] text-subtle">from {fmtDate(r.startDate)}</span>
                    <span className="ml-auto text-[13px] text-muted" data-testid="run-progress">{r.done} of {r.total} done</span>
                    {canAdmin && <Button size="icon" variant="ghost" aria-label={`Remove ${r.name}`} onClick={() => void removeRun(r.id)}><IconTrash className="h-4 w-4" aria-hidden="true" /></Button>}
                  </div>
                  <Meter value={r.done} max={r.total} label={`${r.name} progress`} className="mt-2" />
                  <ul className="mt-2 divide-y divide-line">{r.tasks.map((t) => (
                    <li key={t.taskId} className="flex items-center gap-2 py-1.5 text-[13px]">
                      <span className={cn("h-2 w-2 shrink-0 rounded-full", t.done ? "bg-ok" : "bg-line-strong")} aria-hidden="true" />
                      <Link to={`/app/tasks/${encodeURIComponent(t.taskId)}`} className={cn("min-w-0 flex-1 truncate hover:underline", t.done ? "text-muted line-through" : "text-fg")}>{t.title}<span className="sr-only">{t.done ? ", done" : ", open"}</span></Link>
                      <span className="text-subtle">{fmtDate(t.due)}</span>
                    </li>))}
                  </ul>
                </div>))}
              </div>
            )}
          </Section>
        </div>
      </div>
      <EditProfileDialog open={editing} onClose={() => setEditing(false)} data={q.data} onSaved={refresh} />
      <AwayDialog open={awayOpen} onClose={() => setAwayOpen(false)} userId={userId} onSaved={async () => { await refresh(); await qc.invalidateQueries({ queryKey: ["people-r126", "away"] }); }} />
      <AssignRunDialog open={assigning} onClose={() => setAssigning(false)} person={p} onSaved={refresh} />
    </div>
  );
}

function EditProfileDialog({ open, onClose, data, onSaved }: { open: boolean; onClose: () => void; data: Profile; onSaved: () => Promise<unknown> }) {
  const staff = useQuery({ queryKey: pk.staff, queryFn: getStaff, enabled: open && data.canAdmin });
  const p = data.person;
  const [f, setF] = useState({ title: "", team: "", skills: "", location: "", phone: "", daysOff: [0, 6] as number[], managerUserId: "", startDate: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) { setErr(null); setF({ title: p.title, team: p.team, skills: p.skills.join(", "), location: p.location, phone: p.phone, daysOff: p.daysOff, managerUserId: p.managerUserId ?? "", startDate: p.startDate ?? "" }); }
  }, [open, p]);
  const save = async () => {
    setBusy(true); setErr(null);
    const body: Record<string, unknown> = { title: f.title, team: f.team, skills: cleanTags(f.skills.split(",")), location: f.location, phone: f.phone, daysOff: f.daysOff };
    if (data.canAdmin) { body.managerUserId = f.managerUserId || null; body.startDate = f.startDate || null; }
    try { await api.patch(`/people/staff/${encodeURIComponent(p.userId)}`, body); await onSaved(); toast.success("Profile saved"); onClose(); }
    catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };
  const others = (staff.data?.people ?? []).filter((x) => x.userId !== p.userId);
  return (
    <Dialog open={open} onClose={onClose} title="Edit profile" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} loading={busy} data-testid="profile-save">Save</Button></>}>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {err && <p role="alert" className="text-[13px] text-bad sm:col-span-2">{err}</p>}
        <Field label="Job title">{(x) => <Input {...x} value={f.title} maxLength={80} onChange={(e) => setF({ ...f, title: e.target.value })} data-testid="profile-title" />}</Field>
        <Field label="Team">{(x) => <Input {...x} value={f.team} maxLength={60} onChange={(e) => setF({ ...f, team: e.target.value })} data-testid="profile-team" />}</Field>
        <Field label="Skills" hint="Separate with commas" className="sm:col-span-2">{(x) => <Input {...x} value={f.skills} onChange={(e) => setF({ ...f, skills: e.target.value })} data-testid="profile-skills" />}</Field>
        <Field label="Location">{(x) => <Input {...x} value={f.location} maxLength={80} onChange={(e) => setF({ ...f, location: e.target.value })} />}</Field>
        <Field label="Phone">{(x) => <Input {...x} type="tel" value={f.phone} maxLength={32} onChange={(e) => setF({ ...f, phone: e.target.value })} />}</Field>
        {data.canAdmin && <>
          <Field label="Manager">{(x) => <Select {...x} value={f.managerUserId} onChange={(e) => setF({ ...f, managerUserId: e.target.value })} data-testid="profile-manager"><option value="">No manager</option>{others.map((o) => <option key={o.userId} value={o.userId}>{o.name}</option>)}</Select>}</Field>
          <Field label="Start date">{(x) => <DateInput {...x} value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} data-testid="profile-start" />}</Field>
        </>}
        <div className="sm:col-span-2"><p className="mb-1.5 text-[13px] font-medium text-fg/90">Regular days off</p><DaysOffPicker daysOff={f.daysOff} active onChange={(d) => setF({ ...f, daysOff: d })} /></div>
        <p className="text-[12.5px] text-subtle sm:col-span-2">Pay, tax and ID numbers are never kept here.</p>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}

function AwayDialog({ open, onClose, userId, onSaved }: { open: boolean; onClose: () => void; userId: string; onSaved: () => Promise<unknown> }) {
  const [s, setS] = useState(""); const [e2, setE] = useState(""); const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setS(todayYmd()); setE(todayYmd()); setNote(""); setErr(null); } }, [open]);
  const save = async () => {
    setBusy(true); setErr(null);
    try { await api.create(`/people/staff/${encodeURIComponent(userId)}/away`, { startDate: s, endDate: e2 || s, note }); await onSaved(); toast.success("Time away added"); onClose(); }
    catch (x) { setErr(errorMessage(x)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Add time away" description="It shows on the team's Away view." footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} loading={busy} data-testid="away-save">Add</Button></>}>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(x) => { x.preventDefault(); void save(); }}>
        {err && <p role="alert" className="text-[13px] text-bad sm:col-span-2">{err}</p>}
        <Field label="First day">{(x) => <DateInput {...x} value={s} onChange={(ev) => setS(ev.target.value)} data-testid="away-start" />}</Field>
        <Field label="Last day">{(x) => <DateInput {...x} value={e2} onChange={(ev) => setE(ev.target.value)} data-testid="away-end" />}</Field>
        <Field label="Note" hint="Optional, everyone in the workspace can see it" className="sm:col-span-2">{(x) => <Input {...x} value={note} maxLength={120} onChange={(ev) => setNote(ev.target.value)} />}</Field>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}

function AssignRunDialog({ open, onClose, person, onSaved }: { open: boolean; onClose: () => void; person: StaffPerson; onSaved: () => Promise<unknown> }) {
  const tpl = useQuery({ queryKey: pk.templates, queryFn: getTemplates, enabled: open });
  const [id, setId] = useState(""); const [start, setStart] = useState("");
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setErr(null); setStart(person.startDate ?? todayYmd()); } }, [open, person.startDate]);
  const list: OnboardingTemplate[] = useMemo(() => tpl.data?.templates ?? [], [tpl.data]);
  useEffect(() => { if (list.length && !list.some((t) => t.id === id)) setId(list[0].id); }, [list, id]);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ created: number; moved: number }>(`/people/staff/${encodeURIComponent(person.userId)}/runs`, { templateId: id, startDate: start });
      await onSaved();
      toast.success(r.created ? `${r.created} ${r.created === 1 ? "task" : "tasks"} created` : r.moved ? "Due dates updated. No new tasks needed." : "Already assigned. Nothing new to add.");
      onClose();
    } catch (x) { setErr(errorMessage(x)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Assign checklist" description={`Creates ${person.name}'s tasks in Tasks, due from the date you pick. Assigning again never makes copies.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} loading={busy} disabled={!id} data-testid="run-save">Assign</Button></>}>
      {tpl.isError && !tpl.data ? <LoadError compact onRetry={() => tpl.refetch()} /> : !tpl.data ? <Skeleton className="h-20 rounded-lg" /> : !list.length ? (
        <EmptyState title="No checklists yet" body="Build one in Settings > Team > Onboarding." action={<Link to="/app/settings/team/onboarding" className="text-sm font-medium text-brand hover:underline">Build a checklist</Link>} />
      ) : (
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(x) => { x.preventDefault(); void save(); }}>
          {err && <p role="alert" className="text-[13px] text-bad sm:col-span-2">{err}</p>}
          <Field label="Checklist">{(x) => <Select {...x} value={id} onChange={(e) => setId(e.target.value)} data-testid="run-template">{list.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.kind === "onboarding" ? "onboarding" : "offboarding"}, {t.items.length} steps)</option>)}</Select>}</Field>
          <Field label={list.find((t) => t.id === id)?.kind === "offboarding" ? "Last day" : "Start date"}>{(x) => <DateInput {...x} value={start} onChange={(e) => setStart(e.target.value)} data-testid="run-start" />}</Field>
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </form>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------- asset page and labels

export function AssetPage() {
  const { id = "" } = useParams();
  const config = useConfig();
  const on = !!config.data?.peopleR126;
  const q = useQuery({ queryKey: pk.asset(id), queryFn: () => getAsset(id), enabled: on, ...quickRetry });
  const staff = useQuery({ queryKey: pk.staff, queryFn: getStaff, enabled: on && !!q.data?.canEdit });
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const { confirm, dialogs } = useDialogs();
  useEffect(() => { setTo(q.data?.asset.assignedUserId ?? ""); }, [q.data?.asset.assignedUserId]);
  if (config.data && !on) return <PeopleOff />;
  if (q.isError && notFoundOr(q.error)) return <EmptyState title="Asset not found" body="It isn't in your workspace, or it was removed." action={<Link to="/app/contacts/staff?view=assets" className="text-sm font-medium text-brand hover:underline">Back to Assets</Link>} />;
  if (q.isError && !q.data) return <LoadError onRetry={() => q.refetch()} />;
  if (!q.data) return <div className="mx-auto max-w-4xl space-y-3" aria-busy="true" aria-label="Loading asset"><Skeleton className="h-24 rounded-xl" /><Skeleton className="h-48 rounded-xl" /></div>;
  const { asset: a, history, canEdit } = q.data;
  const assign = async (userId: string | null) => {
    setBusy(true);
    try {
      await api.post(`/people/assets/${encodeURIComponent(a.id)}/assign`, { userId });
      await Promise.all([qc.invalidateQueries({ queryKey: pk.asset(a.id) }), qc.invalidateQueries({ queryKey: pk.assets })]);
      toast.success(userId ? "Asset assigned" : "Asset returned");
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!(await confirm({ title: `Delete ${a.tag}?`, description: "Its history goes too. This can't be undone.", confirmLabel: "Delete", tone: "danger" }))) return;
    try { await api.del(`/people/assets/${encodeURIComponent(a.id)}`); await qc.invalidateQueries({ queryKey: pk.assets }); toast.success("Asset deleted"); window.history.back(); }
    catch (e) { toast.error(errorMessage(e)); }
  };
  const ACTION: Record<string, string> = { created: "Added", assigned: "Assigned to", returned: "Returned by", status: "Status changed to", edited: "Edited" };
  return (
    <div className="mx-auto w-full max-w-4xl" data-testid="asset-page">
      <Back to="/app/contacts/staff?view=assets" label="Assets" />
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[12.5px] text-subtle">{a.tag}</p>
          <h1 className="break-words text-[22px] font-semibold tracking-[-0.01em] text-fg">{a.name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-[13.5px] text-muted"><StatusBadge s={a.status} />{ASSET_KIND_LABEL[a.kind]}{a.assignedName && <> · <Link className="text-fg hover:underline" to={`/app/contacts/staff/${encodeURIComponent(a.assignedUserId!)}`}>{a.assignedName}</Link></>}</p>
        </div>
        {canEdit && <span className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => setEditing(true)} data-testid="asset-edit"><IconEdit className="h-4 w-4" aria-hidden="true" />Edit</Button><Button size="icon" variant="ghost" aria-label="Delete asset" onClick={() => void remove()}><IconTrash className="h-4 w-4" aria-hidden="true" /></Button></span>}
      </div>
      <div className="grid gap-3 md:grid-cols-[1fr,auto]">
        <div className="space-y-3">
          <Section title="Details">
            <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-2 text-[13.5px]">
              <dt className="text-muted">Serial</dt><dd className="break-all text-fg">{a.serial || "Not set"}</dd>
              <dt className="text-muted">Purchased</dt><dd className="text-fg">{fmtDate(a.purchaseDate) || "Not set"}</dd>
              <dt className="text-muted">Warranty end</dt><dd className="text-fg">{fmtDate(a.warrantyEnd) || "Not set"}</dd>
              <dt className="text-muted">Value</dt><dd className="text-fg">{money(a.valueCents) || "Not set"}</dd>
              {a.notes && <><dt className="text-muted">Notes</dt><dd className="whitespace-pre-wrap break-words text-fg">{a.notes}</dd></>}
            </dl>
          </Section>
          {canEdit && a.status !== "retired" && a.status !== "lost" && (
            <Section title="Assigned to">
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Person" className="min-w-[200px] flex-1">{(x) => <Select {...x} value={to} onChange={(e) => setTo(e.target.value)} data-testid="asset-assignee"><option value="">No one (in stock)</option>{(staff.data?.people ?? []).map((p) => <option key={p.userId} value={p.userId}>{p.name}</option>)}</Select>}</Field>
                <Button size="sm" loading={busy} disabled={(to || null) === a.assignedUserId} onClick={() => void assign(to || null)} data-testid="asset-assign">{to ? "Assign" : "Mark returned"}</Button>
              </div>
            </Section>
          )}
          <Section title="History" testId="asset-history">
            <ol className="space-y-2 text-[13px]">{history.map((h) => (
              <li key={h.id} className="flex gap-2"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-line-strong" aria-hidden="true" />
                <span className="min-w-0 flex-1"><span className="text-fg">{ACTION[h.action] ?? h.action} {h.action === "assigned" || h.action === "returned" ? h.userName ?? "someone" : h.detail}</span>
                  <span className="block text-subtle">{new Date(h.at).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" })}{h.byName ? ` by ${h.byName}` : ""}</span></span>
              </li>))}
            </ol>
          </Section>
        </div>
        <Section title="QR label">
          <div className="flex flex-col items-center gap-2">
            <QrCode value={assetUrl(a.id)} size={168} label={`QR label for ${a.tag}. It opens this page for people signed in to your workspace.`} />
            <p className="font-mono text-[13px] text-fg">{a.tag}</p>
            <p className="max-w-[200px] text-center text-[12px] text-subtle">Opens this page only for people signed in to your workspace.</p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => downloadPng(assetUrl(a.id), a.tag, `${a.tag}.png`)}><IconDownload className="h-4 w-4" aria-hidden="true" />PNG</Button>
              <Button size="sm" variant="secondary" onClick={() => downloadSvg(assetUrl(a.id), a.tag, `${a.tag}.svg`)}><IconDownload className="h-4 w-4" aria-hidden="true" />SVG</Button>
              <Link to={`/app/contacts/assets/labels?ids=${encodeURIComponent(a.id)}`} className="inline-flex h-8 items-center rounded-lg bg-fill px-3 text-[13px] hover:bg-hover max-sm:min-h-11">Print</Link>
            </div>
          </div>
        </Section>
      </div>
      <AssetFormDialog open={editing} onClose={() => setEditing(false)} asset={a} />
      {dialogs}
    </div>
  );
}

/** A4 sheet of QR labels (3 across). Printing hides the app around it. */
export function AssetLabelsPage() {
  const config = useConfig();
  const on = !!config.data?.peopleR126;
  const [params] = useSearchParams();
  const q = useQuery({ queryKey: pk.assets, queryFn: getAssets, enabled: on, ...quickRetry });
  const ids = useMemo(() => new Set((params.get("ids") ?? "").split(",").filter(Boolean)), [params]);
  if (config.data && !on) return <PeopleOff />;
  if (q.isError && !q.data) return <LoadError onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-64 rounded-xl" />;
  const list: Asset[] = q.data.assets.filter((a) => !ids.size || ids.has(a.id));
  return (
    <div className="mx-auto w-full max-w-4xl" data-testid="asset-labels">
      <div className="print:hidden">
        <Back to="/app/contacts/staff?view=assets" label="Assets" />
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <h1 className="text-[20px] font-semibold text-fg">Print labels</h1>
          <span className="text-[13px] text-muted">{list.length} {list.length === 1 ? "label" : "labels"}</span>
          <Button size="sm" className="ml-auto" onClick={() => window.print()} disabled={!list.length}>Print</Button>
        </div>
      </div>
      {!list.length ? <EmptyState title="No labels to print" body="Pick assets in the register, then print their labels." /> : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 print:grid-cols-3 print:gap-2">
          {list.map((a) => (
            <li key={a.id} className="flex break-inside-avoid flex-col items-center rounded-lg border border-line bg-white p-3 text-[#09090b] print:border-[#ccc]">
              <QrCode value={assetUrl(a.id)} size={120} label={`QR label for ${a.tag}`} />
              <span className="mt-1 font-mono text-[13px] font-semibold">{a.tag}</span>
              <span className="w-full truncate text-center text-[11.5px]">{a.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
