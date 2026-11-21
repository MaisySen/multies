/**
 * OPS1: the phone app's remote settings in the operator console (GET/PUT /api/console/mobile). A form built from the
 * server's field list, in three sections. Each field shows what phones get now and whether it was set here or is the
 * built in default. "Review changes" opens the reason dialog with a before and after table; raising a minimum
 * version gets a plain warning there and on the page. Read only roles see the same form without the save bar.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, errorMessage } from "@/web/lib/api";
import { consoleKeys } from "@/web/lib/console-api";
import { fullDate, timeAgo } from "@/web/lib/format";
import { Badge, Card, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Field, Input, Textarea } from "@/web/components/ui/input";
import { IconWarning } from "@/web/components/ui/icon";
import { JsonDiff } from "./components/json-diff";
import { useOperatorAction } from "./components/reason-dialog";
import { PermissionGate, usePermission } from "./guard";
import { draftsOf, getPath, raisedMinimums, reviewOf, sectionsOf, showValue, type Drafts, type MobileChange, type MobileConfigResponse, type MobileField } from "./mobile-form";

const mobileKey = [...consoleKeys.all, "mobile"] as const;

function RaiseWarning({ changes }: { changes: MobileChange[] }) {
  return (
    <div role="alert" data-testid="console-mobile-warning" className="flex gap-2.5 rounded-lg border border-warn/20 bg-warn-soft px-3 py-2.5 text-[13px] text-fg">
      <IconWarning className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">This forces people on older builds to update.</p>
        <p className="text-muted">
          Phones below the new minimum ({changes.map((c) => `${c.field.label.toLowerCase()} ${showValue(c.field, c.after)}`).join(", ")}) see
          a screen asking them to update from the store, and can't use the app until they do. Check the new build is live in the store first.
        </p>
      </div>
    </div>
  );
}

function FieldRow({ field, data, value, onChange, error, readOnly }: {
  field: MobileField; data: MobileConfigResponse; value: string; onChange: (v: string) => void; error?: string; readOnly: boolean;
}) {
  const now = getPath(data.effective, field.path);
  const setHere = getPath(data.stored, field.path) !== undefined;
  const testId = `console-mobile-field-${field.path}`;
  return (
    <div className="grid gap-2 py-4 first:pt-0 last:pb-0 md:grid-cols-[minmax(0,1fr)_minmax(0,220px)] md:gap-6">
      <Field label={field.label} hint={field.help} error={error}>
        {(p) => field.type === "update_ids" || field.type === "text" ? (
          <Textarea {...p} rows={field.type === "text" ? 2 : 3} value={value} disabled={readOnly} data-testid={testId}
            placeholder={field.type === "update_ids" ? "One update id per line" : "No message"}
            className={field.type === "update_ids" ? "font-mono text-[13px]" : undefined}
            onChange={(e) => onChange(e.target.value)} />
        ) : (
          <Input {...p} value={value} disabled={readOnly} data-testid={testId} inputMode={field.type === "integer" ? "numeric" : undefined}
            placeholder={field.nullable ? showValue(field, null) : undefined} autoComplete="off" spellCheck={false}
            onChange={(e) => onChange(e.target.value)} />
        )}
      </Field>
      <div className="min-w-0 text-xs md:pt-6">
        <p className="text-subtle">Phones get now</p>
        <p className="mt-0.5 font-mono text-[13px] text-fg [overflow-wrap:anywhere]" data-testid={`${testId}-now`}>{showValue(field, now)}</p>
        <p className="mt-1.5">{setHere ? <Badge tone="brand">Set here</Badge> : <Badge>Default</Badge>}</p>
      </div>
    </div>
  );
}

function MobileForm({ data }: { data: MobileConfigResponse }) {
  const canSave = usePermission("mobile.manage");
  const initial = useMemo(() => draftsOf(data.fields, data.effective), [data]);
  const [drafts, setDrafts] = useState<Drafts>(initial);
  const review = useMemo(() => reviewOf(data.fields, data.effective, drafts), [data, drafts]);
  const raised = raisedMinimums(review.changes);
  const dirty = review.changes.length > 0;
  const hasErrors = Object.keys(review.errors).length > 0;
  const touched = (path: string) => drafts[path] !== initial[path];
  const label = (c: MobileChange) => c.field.label;

  const save = useOperatorAction<void>({
    title: "Review changes",
    description: "Phones pick these up the next time they open the app or check for settings, usually within a few minutes.",
    confirmLabel: "Save changes",
    fields: (
      <div className="space-y-3">
        <JsonDiff
          before={Object.fromEntries(review.changes.map((c) => [label(c), showValue(c.field, c.before)]))}
          after={Object.fromEntries(review.changes.map((c) => [label(c), showValue(c.field, c.after)]))}
        />
        {raised.length > 0 && <RaiseWarning changes={raised} />}
      </div>
    ),
    run: (_v, reason) => api.put<MobileConfigResponse>("/console/mobile", { patch: review.patch, reason }),
    success: "Mobile app settings saved",
    invalidate: [mobileKey],
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted" data-testid="console-mobile-updated">
        {data.updatedAt
          ? <>Last changed <span title={fullDate(data.updatedAt)}>{timeAgo(data.updatedAt)}</span>{data.updatedByEmail ? ` by ${data.updatedByEmail}` : data.updatedBy === "token" ? " by a release script" : ""}.</>
          : "Nothing has been changed here yet. Phones use the built in defaults."}
      </p>
      {sectionsOf(data.fields).map((s) => (
        <Card key={s.id} className="p-4 sm:p-5" data-testid={`console-mobile-section-${s.id}`}>
          <h2 className="text-[15px] font-semibold">{s.title}</h2>
          {s.description && <p className="mt-0.5 text-sm text-muted">{s.description}</p>}
          {s.id === "minimum" && (
            <p className="mt-3 flex gap-2 rounded-lg bg-fill px-3 py-2 text-[13px] text-muted">
              <IconWarning className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" aria-hidden />
              Raising a minimum forces everyone on an older build to update from the store before they can keep using the app.
            </p>
          )}
          <div className="mt-4 divide-y divide-line">
            {s.fields.map((f) => (
              <FieldRow key={f.path} field={f} data={data} value={drafts[f.path] ?? ""} readOnly={!canSave}
                error={touched(f.path) ? review.errors[f.path] : undefined}
                onChange={(v) => setDrafts((d) => ({ ...d, [f.path]: v }))} />
            ))}
          </div>
        </Card>
      ))}
      <PermissionGate permission="mobile.manage">
        <div className="sticky bottom-0 z-10 -mx-1 flex flex-col gap-3 rounded-xl border border-line bg-surface/95 px-4 py-3 shadow-card backdrop-blur sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted" data-testid="console-mobile-status">
            {hasErrors ? "Fix the highlighted fields to continue." : dirty ? `${review.changes.length} ${review.changes.length === 1 ? "change" : "changes"} not saved yet.` : "No changes yet."}
          </p>
          <div className="flex gap-2 max-sm:flex-col-reverse">
            <Button variant="secondary" disabled={!dirty && !hasErrors} onClick={() => setDrafts(initial)} data-testid="console-mobile-discard">Discard</Button>
            <Button disabled={!dirty || hasErrors} onClick={() => save.open()} data-testid="console-mobile-review">Review changes</Button>
          </div>
        </div>
      </PermissionGate>
      {save.dialog}
    </div>
  );
}

export function ConsoleMobilePage() {
  const q = useQuery({ queryKey: mobileKey, queryFn: () => api.get<MobileConfigResponse>("/console/mobile") });
  const header = <PageHeader eyebrow="Product" title="Mobile app" description="The phone app's remote settings: the oldest version allowed, urgent updates and the update screen message." />;
  if (q.isPending) return (
    <div className="space-y-4" aria-busy="true">
      {header}
      <Skeleton className="h-5 w-72" />
      <Skeleton className="h-72 rounded-xl" />
      <Skeleton className="h-56 rounded-xl" />
    </div>
  );
  if (q.error) return (
    <div className="space-y-4">
      {header}
      <Card className="p-0"><EmptyState icon={<IconWarning />} title="Couldn't load the mobile app settings" body={errorMessage(q.error)} action={<Button variant="secondary" onClick={() => void q.refetch()}>Try again</Button>} /></Card>
    </div>
  );
  return (
    <div className="space-y-4">
      {header}
      {/* A fresh form after each save (or someone else's), so the drafts start from what phones get now. */}
      <MobileForm key={q.data.updatedAt ?? "defaults"} data={q.data} />
    </div>
  );
}
