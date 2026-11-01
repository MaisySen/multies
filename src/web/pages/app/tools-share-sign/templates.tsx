/**
 * R107: e-sign templates. A template is a placed document with roles instead of people. Use it to send one
 * request, or (one role templates) send it to a pasted list: one request per person, links go out a few at a time.
 * Everyone in the workspace can use a template; the person who made it or an admin can delete it.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { useMailboxes } from "@/web/lib/queries";
import { Button } from "@/web/components/ui/button";
import { Select } from "@/web/components/ui/input";
import { Dialog } from "@/web/components/ui/dialog";
import { ConfirmDialog } from "@/web/components/ui/confirm";
import { Badge, Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { IconSend } from "@/web/components/ui/icon";
import { SIGN_BULK_MAX, type SignRequestInfo, type SignTemplateInfo } from "@/shared/share-sign";
import { LoadFailure } from "@/web/components/load-error-t1g";

const field = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-brand";

function MailboxSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const mailboxes = useMailboxes();
  return (
    <label className="block space-y-1 text-[13px] font-medium">Send from
      <Select value={value} onChange={(e) => onChange(e.target.value)} data-testid="tpl-mailbox">
        <option value="">Choose a mailbox</option>
        {(mailboxes.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.address}</option>)}
      </Select>
    </label>
  );
}

function UseDialog({ t, onClose }: { t: SignTemplateInfo; onClose: () => void }) {
  const [, setParams] = useSearchParams();
  const qc = useQueryClient();
  const [people, setPeople] = useState(t.roles.map(() => ({ name: "", email: "" })));
  const [mailboxId, setMailboxId] = useState("");
  const ready = mailboxId && people.every((p) => p.name.trim() && /\S+@\S+\.\S+/.test(p.email));
  const m = useMutation({
    mutationFn: () => api.post<SignRequestInfo>(`/tools/esign/templates/${t.id}/send`, { signers: people.map((p) => ({ name: p.name.trim(), email: p.email.trim() })), mailboxId }),
    onSuccess: async (r) => { toast.success("Sent for signing"); await qc.invalidateQueries({ queryKey: ["tools-esign"] }); await qc.invalidateQueries({ queryKey: ["tools-esign-templates"] }); onClose(); setParams({ request: r.id }); },
  });
  return (
    <Dialog open onClose={onClose} title={`Send ${t.name}`} description={`${t.title}. ${t.orderMode === "sequence" ? "Signed in order." : "Signed in any order."}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => m.mutate()} loading={m.isPending} disabled={!ready} data-testid="tpl-send"><IconSend className="h-4 w-4" />Send for signing</Button></>}>
      <div className="space-y-3">
        {t.roles.map((role, i) => (
          <fieldset key={i} className="space-y-1.5 rounded-lg border border-line p-2.5">
            <legend className="px-1 text-[12px] text-muted">{role}</legend>
            <input className={field} placeholder="Name" aria-label={`${role} name`} maxLength={120} value={people[i].name} onChange={(e) => setPeople(people.map((p, j) => (j === i ? { ...p, name: e.target.value } : p)))} />
            <input className={field} placeholder="Email" type="email" aria-label={`${role} email`} maxLength={254} value={people[i].email} onChange={(e) => setPeople(people.map((p, j) => (j === i ? { ...p, email: e.target.value } : p)))} />
          </fieldset>
        ))}
        <MailboxSelect value={mailboxId} onChange={setMailboxId} />
        {m.error && <p role="alert" className="text-sm text-bad">{errorMessage(m.error)}</p>}
      </div>
    </Dialog>
  );
}

function BulkDialog({ t, onClose }: { t: SignTemplateInfo; onClose: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [mailboxId, setMailboxId] = useState("");
  const preview = useQuery({
    queryKey: ["tools-esign-parse", text], enabled: text.trim().length > 3, staleTime: 60_000,
    queryFn: () => api.post<{ rows: { name: string; email: string }[]; bad: number[]; over: number }>("/tools/esign/templates/parse-list", { text }),
  });
  const rows = preview.data?.rows ?? [];
  const bad = preview.data?.bad ?? [];
  const m = useMutation({
    mutationFn: () => api.post<{ count: number; sentNow: number }>(`/tools/esign/templates/${t.id}/bulk`, { text, mailboxId }),
    onSuccess: async (r) => {
      toast.success(r.count === r.sentNow ? `Sent to ${r.count} ${r.count === 1 ? "person" : "people"}` : `Sending to ${r.count} people. The first ${r.sentNow} went now, the rest within the hour.`);
      await qc.invalidateQueries({ queryKey: ["tools-esign"] }); await qc.invalidateQueries({ queryKey: ["tools-esign-templates"] }); onClose();
    },
  });
  const ok = mailboxId && rows.length > 0 && !bad.length && !preview.data?.over;
  return (
    <Dialog open onClose={onClose} title={`Send ${t.name} to a list`} description={`Each person gets their own copy to sign. Up to ${SIGN_BULK_MAX} people.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => m.mutate()} loading={m.isPending} disabled={!ok} data-testid="tpl-bulk-send"><IconSend className="h-4 w-4" />{rows.length ? `Send to ${rows.length}` : "Send"}</Button></>}>
      <div className="space-y-3">
        <label className="block space-y-1 text-[13px] font-medium">People, one a line
          <textarea className={`${field} font-mono text-[13px]`} rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={"Alex Chen, alex@example.com\nSam Lee, sam@example.com"} data-testid="tpl-bulk-text" />
        </label>
        <p className="text-[12px] text-muted" aria-live="polite" data-testid="tpl-bulk-preview">
          {bad.length ? `Line ${bad.slice(0, 5).join(", ")} has no email address.` : preview.data?.over ? `That is more than ${SIGN_BULK_MAX} people. Split the list.` : rows.length ? `${rows.length} ${rows.length === 1 ? "person" : "people"} ready.` : "Paste names and email addresses, or just email addresses."}
        </p>
        <MailboxSelect value={mailboxId} onChange={setMailboxId} />
        {m.error && <p role="alert" className="text-sm text-bad">{errorMessage(m.error)}</p>}
      </div>
    </Dialog>
  );
}

export function TemplatesPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["tools-esign-templates"], queryFn: () => api.get<{ templates: SignTemplateInfo[] }>("/tools/esign/templates") });
  const [using, setUsing] = useState<SignTemplateInfo | null>(null);
  const [bulk, setBulk] = useState<SignTemplateInfo | null>(null);
  const [del, setDel] = useState<SignTemplateInfo | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/tools/esign/templates/${id}`),
    onSuccess: async () => { toast.success("Template deleted"); setDel(null); await qc.invalidateQueries({ queryKey: ["tools-esign-templates"] }); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (q.isLoading) return <div className="space-y-2" data-testid="tpl-loading">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>;
  if (q.isError) return <LoadFailure block error={q.error} onRetry={() => q.refetch()} />;
  const list = q.data?.templates ?? [];
  if (!list.length) return <EmptyState title="No templates yet" body="Open a document, choose Ask others to sign, place the fields, then Save as template." />;
  return (
    <div className="space-y-2" data-testid="tpl-list">
      {list.map((t) => (
        <Card key={t.id} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center" data-testid="tpl-row">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{t.name}</p>
            <p className="truncate text-[12px] text-muted">{t.title} · {t.roles.join(", ")} · {t.fieldCount} {t.fieldCount === 1 ? "field" : "fields"}{t.uses ? ` · used ${t.uses} ${t.uses === 1 ? "time" : "times"}` : ""}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {t.orderMode === "sequence" && <Badge tone="neutral">In order</Badge>}
            <Button size="sm" onClick={() => setUsing(t)} data-testid="tpl-use">Use</Button>
            {t.roles.length === 1 && <Button size="sm" variant="outline" onClick={() => setBulk(t)} data-testid="tpl-bulk">Send to a list</Button>}
            {t.canDelete && <Button size="sm" variant="ghost" onClick={() => setDel(t)} data-testid="tpl-delete">Delete</Button>}
          </div>
        </Card>
      ))}
      {using && <UseDialog t={using} onClose={() => setUsing(null)} />}
      {bulk && <BulkDialog t={bulk} onClose={() => setBulk(null)} />}
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} onConfirm={() => del && remove.mutate(del.id)} title={`Delete ${del?.name ?? "template"}?`}
        description="Requests already sent from it keep working. This cannot be undone." confirmLabel="Delete template" />
    </div>
  );
}
