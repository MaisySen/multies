import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/web/lib/api";
import { useMailboxes, useMe } from "@/web/lib/queries";
import { Badge, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Field, Input, Select } from "@/web/components/ui/input";
import { timeAgo } from "@/web/lib/format";
import { Section } from "./settings";

interface ImportJob { id: string; mailboxId: string; provider: string; sourceUser: string; status: "queued" | "running" | "done" | "failed" | "cancelled"; messagesDone: number; messagesTotal: number | null; error: string | null; createdAt: string }
interface Provider { id: "gmail" | "outlook" | "imap"; label: string; help: string; host: string }
interface ImportsInfo { enabled: boolean; providers: Provider[]; imports: ImportJob[] }

const TONE = { queued: "neutral", running: "brand", done: "ok", failed: "bad", cancelled: "neutral" } as const;
const LABEL = { queued: "Waiting to start", running: "Copying", done: "Done", failed: "Failed", cancelled: "Cancelled" } as const;

/** Bring old mail over from Gmail, Outlook or IMAP. Shown when importing is switched on. */
export function ImportSection() {
  const me = useMe();
  const qc = useQueryClient();
  const isAdmin = me.data?.organization?.role !== "member";
  const info = useQuery({ queryKey: ["imports"], queryFn: () => api.get<ImportsInfo>("/imports"), enabled: isAdmin,
    refetchInterval: (q) => (q.state.data?.imports.some((j) => j.status === "queued" || j.status === "running") ? 5000 : false) });
  const mailboxes = useMailboxes();
  const [f, setF] = useState({ provider: "gmail" as Provider["id"], mailboxId: "", sourceUser: "", appPassword: "", sourceHost: "" });
  const start = useMutation({
    mutationFn: () => api.post("/imports", { ...f, mailboxId: f.mailboxId || mailboxes.data?.[0]?.id, ...(f.provider === "imap" ? {} : { sourceHost: undefined }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["imports"] }); setF({ ...f, appPassword: "" }); toast.success("Import started. You can close this page."); },
  });
  const cancel = useMutation({ mutationFn: (id: string) => api.post(`/imports/${id}/cancel`, {}), onSuccess: () => qc.invalidateQueries({ queryKey: ["imports"] }) });
  if (!isAdmin || info.data?.enabled === false) return null;
  const provider = info.data?.providers.find((p) => p.id === f.provider);
  return (
    <Section id="import" title="Import old mail" description="Copy mail from Gmail, Outlook or another IMAP server into a mailbox. It runs in the background, and running it again only adds new mail.">
      {info.isPending ? <Skeleton className="h-24" /> : (
        <div className="space-y-5">
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); start.mutate(); }}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="From">{(p) => <Select {...p} value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value as Provider["id"] })}>{info.data?.providers.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select>}</Field>
              <Field label="Into mailbox">{(p) => <Select {...p} value={f.mailboxId} onChange={(e) => setF({ ...f, mailboxId: e.target.value })}>{mailboxes.data?.map((m) => <option key={m.id} value={m.id}>{m.address}</option>)}</Select>}</Field>
              <Field label="Old address">{(p) => <Input {...p} type="email" autoComplete="off" value={f.sourceUser} onChange={(e) => setF({ ...f, sourceUser: e.target.value })} placeholder="you@gmail.com" />}</Field>
              <Field label="App password" hint={provider?.help}>{(p) => <Input {...p} type="password" autoComplete="new-password" value={f.appPassword} onChange={(e) => setF({ ...f, appPassword: e.target.value })} />}</Field>
              {f.provider === "imap" && <Field label="IMAP server">{(p) => <Input {...p} value={f.sourceHost} onChange={(e) => setF({ ...f, sourceHost: e.target.value })} placeholder="imap.example.com" />}</Field>}
            </div>
            {start.error instanceof ApiError && <p className="text-sm text-bad">{start.error.message}</p>}
            <Button type="submit" size="sm" loading={start.isPending} disabled={!f.sourceUser || !f.appPassword || !mailboxes.data?.length}>Start import</Button>
          </form>
          {!!info.data?.imports.length && (
            <ul className="divide-y divide-line border-y border-line text-sm">
              {info.data.imports.map((j) => (
                <li key={j.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <span className="min-w-0 flex-1 truncate">{j.sourceUser} <span className="text-subtle">into {mailboxes.data?.find((m) => m.id === j.mailboxId)?.address ?? "a mailbox"}</span></span>
                  <Badge tone={TONE[j.status]} dot>{LABEL[j.status]}</Badge>
                  <span className="text-xs tabular-nums text-subtle">{j.messagesDone}{j.messagesTotal ? ` of ${j.messagesTotal}` : ""} messages, {timeAgo(j.createdAt)}</span>
                  {(j.status === "queued" || j.status === "running") && <Button size="sm" variant="ghost" onClick={() => cancel.mutate(j.id)}>Cancel</Button>}
                  {j.error && <p className="w-full text-xs text-bad">{j.error}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Section>
  );
}

interface XeroInfo { configured: boolean; connected: boolean; tenantName?: string | null }

/** Xero, when this MyMail has it set up: connect to chase unpaid invoices from the reminder dialog. */
export function XeroSection() {
  const me = useMe();
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ["integrations"], queryFn: async () => (await api.get<{ xero: XeroInfo }>("/integrations")).xero });
  const off = useMutation({ mutationFn: () => api.del("/integrations/xero"), onSuccess: () => qc.invalidateQueries({ queryKey: ["integrations"] }) });
  if (!info.data?.configured) return null;
  const isAdmin = me.data?.organization?.role !== "member";
  return (
    <Section id="xero" title="Xero" description="See unpaid invoices when you write a reminder. MyMail only reads invoices and contacts.">
      {info.data.connected ? (
        <div className="flex flex-wrap items-center gap-3 text-sm"><Badge tone="ok" dot>Connected</Badge><span>{info.data.tenantName}</span>
          {isAdmin && <Button size="sm" variant="ghost" loading={off.isPending} onClick={() => off.mutate()}>Disconnect</Button>}</div>
      ) : isAdmin ? <a className="inline-flex items-center rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:bg-hover" href="/api/integrations/xero/connect">Connect Xero</a>
        : <p className="text-sm text-muted">An admin can connect Xero.</p>}
    </Section>
  );
}
