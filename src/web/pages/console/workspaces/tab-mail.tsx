/**
 * OPS1: the Mail tab of a workspace: messages a sending limit held (with Send anyway), domains and mailboxes. No
 * message content is ever shown here.
 */
import { api } from "@/web/lib/api";
import { formatBytes } from "@/web/lib/format";
import { Badge, tableStyles as T } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { IconGlobe, IconMail, IconSend } from "@/web/components/ui/icon";
import { DataTable } from "../components/data-table";
import { useOperatorAction } from "../components/reason-dialog";
import { PermissionGate } from "../guard";
import { EmptyBlock, ErrorBlock, LoadingBlock, Section, When, apiPath, useWorkspacePart } from "./tab-shared";

interface Domain { id: string; name: string; status: "pending" | "verified" | "failed"; providerStatus: string | null; verifiedAt: string | null; lastCheckedAt: string | null; createdAt: string; mailboxes: number }
interface Mailbox { id: string; domainId: string; address: string; displayName: string; kind: "person" | "agent"; status: "active" | "suspended"; personal: boolean; quotaMb: number; usedBytes: number; createdAt: string }
interface MailData { domains: Domain[]; mailboxes: Mailbox[]; truncated: { domains: boolean; mailboxes: boolean } }
interface QueuedSend { id: string; mailboxAddress: string | null; reason: string; recipients: number; forced: boolean; dueAt: string; createdAt: string }

const DOMAIN_TONE = { verified: "ok", pending: "warn", failed: "bad" } as const;
const DOMAIN_LABEL = { verified: "Verified", pending: "Waiting for DNS", failed: "Failed" } as const;

function QueuedSends({ orgId }: { orgId: string }) {
  const force = useOperatorAction<QueuedSend>({
    title: "Send this message now?",
    description: "It goes out on the next send run, past the limit that held it. It still will not send while sending is off for the workspace.",
    confirmLabel: "Send anyway",
    run: (s, reason) => api.post(apiPath(orgId, `/queued-sends/${encodeURIComponent(s.id)}/send`), { reason }),
    success: "Message will send shortly",
  });
  return (
    <Section title="Held by a sending limit" description="Messages a daily limit queued until tomorrow. Subjects, bodies and recipients are not shown.">
      <DataTable<QueuedSend>
        label="Held messages" path={`/workspaces/${encodeURIComponent(orgId)}/queued-sends`} defaultSort="dueAt:asc"
        rowKey={(s) => s.id}
        empty={{ icon: <IconSend />, title: "Nothing held", body: "No messages are waiting on a sending limit." }}
        columns={[
          { key: "from", header: "From", cell: (s) => <span className="[overflow-wrap:anywhere]">{s.mailboxAddress ?? "Unknown mailbox"}</span> },
          { key: "why", header: "Why it was held", cell: (s) => <span className="line-clamp-2 max-w-xs">{s.reason}</span> },
          { key: "to", header: "Recipients", align: "right", cell: (s) => <span className="tabular-nums">{s.recipients}</span> },
          { key: "due", header: "Sends", sort: "dueAt", cell: (s) => (s.forced ? <Badge tone="ok" dot>Sending now</Badge> : <When at={s.dueAt} />) },
          {
            key: "act", header: "", align: "right",
            cell: (s) => (s.forced ? null : (
              <PermissionGate permission="workspaces.limits">
                <Button size="sm" variant="secondary" onClick={() => force.open(s)} data-testid="console-workspaces-force-send">Send anyway</Button>
              </PermissionGate>
            )),
          },
        ]}
      />
      {force.dialog}
    </Section>
  );
}

export function WorkspaceMailTab({ orgId }: { orgId: string }) {
  const q = useWorkspacePart<MailData>(orgId, "mail");
  return (
    <div className="space-y-6" data-testid="console-workspaces-mail">
      <QueuedSends orgId={orgId} />
      {q.isPending ? <LoadingBlock /> : q.error ? <ErrorBlock error={q.error} retry={() => void q.refetch()} /> : (
        <>
          <Section title="Domains" description={q.data.truncated.domains ? "Showing the newest 500." : undefined}>
            {!q.data.domains.length ? <EmptyBlock icon={<IconGlobe />} title="No domains" body="This workspace has not added a domain." /> : (
              <div className={T.wrap} tabIndex={0} role="region" aria-label="Domains">
                <table className={T.table}>
                  <thead className={T.head}><tr><th className={T.th}>Domain</th><th className={T.th}>Status</th><th className={`${T.th} text-right`}>Mailboxes</th><th className={T.th}>Last checked</th><th className={`${T.th} text-right`}>Added</th></tr></thead>
                  <tbody className={T.body}>
                    {q.data.domains.map((d) => (
                      <tr key={d.id} className={T.row}>
                        <td className={`${T.td} font-medium [overflow-wrap:anywhere]`}>{d.name}</td>
                        <td className={T.td}><Badge tone={DOMAIN_TONE[d.status]} dot>{DOMAIN_LABEL[d.status]}</Badge></td>
                        <td className={`${T.td} text-right tabular-nums`}>{d.mailboxes}</td>
                        <td className={T.td}><When at={d.lastCheckedAt} /></td>
                        <td className={`${T.td} text-right`}><When at={d.createdAt} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
          <Section title="Mailboxes" description={q.data.truncated.mailboxes ? "Showing the newest 500." : undefined}>
            {!q.data.mailboxes.length ? <EmptyBlock icon={<IconMail />} title="No mailboxes" body="This workspace has no mailboxes yet." /> : (
              <div className={T.wrap} tabIndex={0} role="region" aria-label="Mailboxes">
                <table className={T.table}>
                  <thead className={T.head}><tr><th className={T.th}>Address</th><th className={T.th}>Kind</th><th className={T.th}>Status</th><th className={`${T.th} text-right`}>Storage</th><th className={`${T.th} text-right`}>Added</th></tr></thead>
                  <tbody className={T.body}>
                    {q.data.mailboxes.map((m) => (
                      <tr key={m.id} className={T.row}>
                        <td className={T.td}><span className="flex flex-col"><span className="font-medium [overflow-wrap:anywhere]">{m.address}</span>{m.displayName && <span className="text-xs text-subtle">{m.displayName}</span>}</span></td>
                        <td className={T.td}>{m.kind === "agent" ? "Agent inbox" : m.personal ? "Personal" : "Shared"}</td>
                        <td className={T.td}><Badge tone={m.status === "active" ? "ok" : "bad"} dot>{m.status === "active" ? "Active" : "Suspended"}</Badge></td>
                        <td className={`${T.td} text-right tabular-nums whitespace-nowrap`}>{formatBytes(m.usedBytes)} of {formatBytes(m.quotaMb * 1024 * 1024)}</td>
                        <td className={`${T.td} text-right`}><When at={m.createdAt} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
