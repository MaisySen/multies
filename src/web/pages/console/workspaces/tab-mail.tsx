/**
 * OPS1: the Mail tab of a workspace: messages a sending limit held (with Send anyway), domains and mailboxes. No
 * message content is ever shown here. An empty section is one line (EmptyRow), not a big card.
 */
import { api } from "@/web/lib/api";
import { formatBytes } from "@/web/lib/format";
import { Button } from "@/web/components/ui/button";
import { IconGlobe, IconMail, IconSend } from "@/web/components/ui/icon";
import { DataTable, consoleTable as T } from "../components/data-table";
import { useOperatorAction } from "../components/reason-dialog";
import { EmptyRow, LoadError, RelTime, StatusBadge } from "../components/format";
import { PermissionGate } from "../guard";
import { LoadingBlock, Section, apiPath, useWorkspacePart } from "./tab-shared";

interface Domain { id: string; name: string; status: "pending" | "verified" | "failed"; providerStatus: string | null; verifiedAt: string | null; lastCheckedAt: string | null; createdAt: string; mailboxes: number }
interface Mailbox { id: string; domainId: string; address: string; displayName: string; kind: "person" | "agent"; status: "active" | "suspended"; personal: boolean; quotaMb: number; usedBytes: number; createdAt: string }
interface MailData { domains: Domain[]; mailboxes: Mailbox[]; truncated: { domains: boolean; mailboxes: boolean } }
interface QueuedSend { id: string; mailboxAddress: string | null; reason: string; recipients: number; forced: boolean; dueAt: string; createdAt: string }

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
    <Section title="Held by a sending limit" description="Messages a daily limit queued until tomorrow. Subjects, bodies and recipients are not shown." testId="console-workspaces-held">
      <DataTable<QueuedSend>
        embedded label="Held messages" path={`/workspaces/${encodeURIComponent(orgId)}/queued-sends`} defaultSort="dueAt:asc"
        rowKey={(s) => s.id}
        empty={{ icon: <IconSend />, title: "Nothing held.", body: "No messages are waiting on a sending limit." }}
        columns={[
          { key: "from", header: "From", className: "font-medium", cell: (s) => s.mailboxAddress ?? "Unknown mailbox" },
          { key: "why", header: "Why it was held", secondary: true, cell: (s) => <span className="line-clamp-2 max-w-xs">{s.reason}</span> },
          { key: "recipients", header: "Recipients", align: "right", className: "tabular-nums", cell: (s) => s.recipients },
          { key: "sends", header: "Sends", cell: (s) => (s.forced ? <StatusBadge state="sent" label="Sending now" /> : <RelTime at={s.dueAt} />) },
          { key: "actions", header: "", align: "right", cell: (s) => (s.forced ? null : (
            <PermissionGate permission="workspaces.limits">
              <Button size="sm" variant="secondary" onClick={() => force.open(s)} data-testid="console-workspaces-force-send">Send anyway</Button>
            </PermissionGate>
          )) },
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
      {q.isPending ? <LoadingBlock /> : q.error ? <LoadError error={q.error} retry={() => void q.refetch()} what="domains and mailboxes" /> : (
        <>
          <Section title="Domains" description={q.data.truncated.domains ? "Showing the newest 500." : undefined}>
            {!q.data.domains.length ? <EmptyRow icon={<IconGlobe />}>No domains. This workspace has not added one.</EmptyRow> : (
              <div className={T.wrap} tabIndex={0} role="region" aria-label="Domains">
                <table className={T.table}>
                  <thead className={T.head}><tr><th className={T.th}>Domain</th><th className={T.th}>Status</th><th className={`${T.th} text-right`}>Mailboxes</th><th className={`${T.th} ${T.secondary}`}>Last checked</th><th className={`${T.th} ${T.secondary} text-right`}>Added</th></tr></thead>
                  <tbody className={T.body}>
                    {q.data.domains.map((d) => (
                      <tr key={d.id} className={T.row}>
                        <td className={`${T.td} font-medium`}>{d.name}</td>
                        <td className={T.td}><StatusBadge state={d.status} label={DOMAIN_LABEL[d.status]} /></td>
                        <td className={`${T.td} text-right tabular-nums`}>{d.mailboxes}</td>
                        <td className={`${T.td} ${T.secondary}`}><RelTime at={d.lastCheckedAt} /></td>
                        <td className={`${T.td} ${T.secondary} text-right`}><RelTime at={d.createdAt} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
          <Section title="Mailboxes" description={q.data.truncated.mailboxes ? "Showing the newest 500." : undefined}>
            {!q.data.mailboxes.length ? <EmptyRow icon={<IconMail />}>No mailboxes yet.</EmptyRow> : (
              <div className={T.wrap} tabIndex={0} role="region" aria-label="Mailboxes">
                <table className={T.table}>
                  <thead className={T.head}><tr><th className={T.th}>Address</th><th className={T.th}>Kind</th><th className={T.th}>Status</th><th className={`${T.th} ${T.secondary} text-right`}>Storage</th><th className={`${T.th} ${T.secondary} text-right`}>Added</th></tr></thead>
                  <tbody className={T.body}>
                    {q.data.mailboxes.map((m) => (
                      <tr key={m.id} className={T.row}>
                        <td className={T.td}><span className="flex min-w-0 flex-col"><span className="font-medium">{m.address}</span>{m.displayName && <span className="text-xs text-subtle">{m.displayName}</span>}</span></td>
                        <td className={`${T.td} whitespace-nowrap`}>{m.kind === "agent" ? "Agent inbox" : m.personal ? "Personal" : "Shared"}</td>
                        <td className={T.td}><StatusBadge state={m.status} label={m.status === "active" ? "Active" : "Suspended"} /></td>
                        <td className={`${T.td} ${T.secondary} whitespace-nowrap text-right tabular-nums`}>{formatBytes(m.usedBytes)} of {formatBytes(m.quotaMb * 1024 * 1024)}</td>
                        <td className={`${T.td} ${T.secondary} text-right`}><RelTime at={m.createdAt} /></td>
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
