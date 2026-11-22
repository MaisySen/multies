/** OPS1: the Agents tab of a workspace: its agent inboxes and AI agent members. An empty section is one line. */
import { IconAgent } from "@/web/components/ui/icon";
import { consoleTable as T } from "../components/data-table";
import { EmptyRow, LoadError, RelTime, StatusBadge } from "../components/format";
import { LoadingBlock, Section, useWorkspacePart } from "./tab-shared";
import { LOCALE } from "@/shared/locale";

interface Agent {
  id: string; name: string; description: string | null; address: string | null; approvalMode: "always" | "external" | "never";
  sendCapDaily: number; status: "active" | "paused"; allowedRecipients: string[] | null; apiKeys: number; createdAt: string;
}
interface AgentMember { id: string; userId: string; name: string; title: string | null; disabledAt: string | null; linkedAgentId: string | null; createdAt: string }
interface AgentsData { agents: Agent[]; agentMembers: AgentMember[]; truncated: { agents: boolean; agentMembers: boolean } }

const APPROVAL = { always: "Every message", external: "Outside recipients", never: "Never" } as const;

export function WorkspaceAgentsTab({ orgId }: { orgId: string }) {
  const q = useWorkspacePart<AgentsData>(orgId, "agents");
  if (q.isPending) return <LoadingBlock />;
  if (q.error) return <LoadError error={q.error} retry={() => void q.refetch()} what="agents" />;
  const { agents, agentMembers, truncated } = q.data;
  return (
    <div className="space-y-6" data-testid="console-workspaces-agents">
      <Section title="Agent inboxes" description={truncated.agents ? "Showing the newest 500." : "Inboxes that AI agents use through the API and MCP."}>
        {!agents.length ? <EmptyRow icon={<IconAgent />}>No agent inboxes. This workspace has not set one up.</EmptyRow> : (
          <div className={T.wrap} tabIndex={0} role="region" aria-label="Agent inboxes">
            <table className={T.table}>
              <thead className={T.head}><tr><th className={T.th}>Agent</th><th className={T.th}>Status</th><th className={`${T.th} ${T.secondary}`}>Needs approval</th><th className={`${T.th} text-right`}>Daily cap</th><th className={`${T.th} ${T.secondary} text-right`}>API keys</th><th className={`${T.th} ${T.secondary} text-right`}>Added</th></tr></thead>
              <tbody className={T.body}>
                {agents.map((a) => (
                  <tr key={a.id} className={T.row}>
                    <td className={T.td}><span className="flex min-w-0 flex-col"><span className="font-medium">{a.name}</span>{a.address && <span className="text-xs text-subtle">{a.address}</span>}</span></td>
                    <td className={T.td}><StatusBadge state={a.status} label={a.status === "active" ? "Active" : "Paused"} /></td>
                    <td className={`${T.td} ${T.secondary}`}>{APPROVAL[a.approvalMode]}{a.allowedRecipients && <span className="block text-xs text-subtle">Only {a.allowedRecipients.length} allowed recipients</span>}</td>
                    <td className={`${T.td} text-right tabular-nums`}>{a.sendCapDaily.toLocaleString(LOCALE)}</td>
                    <td className={`${T.td} ${T.secondary} text-right tabular-nums`}>{a.apiKeys}</td>
                    <td className={`${T.td} ${T.secondary} text-right`}><RelTime at={a.createdAt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section title="Agent members" description={truncated.agentMembers ? "Showing the newest 500." : "AI teammates in People. They take no seat."}>
        {!agentMembers.length ? <EmptyRow icon={<IconAgent />}>No agent members.</EmptyRow> : (
          <div className={T.wrap} tabIndex={0} role="region" aria-label="Agent members">
            <table className={T.table}>
              <thead className={T.head}><tr><th className={T.th}>Name</th><th className={T.th}>Status</th><th className={`${T.th} text-right`}>Added</th></tr></thead>
              <tbody className={T.body}>
                {agentMembers.map((m) => (
                  <tr key={m.id} className={T.row}>
                    <td className={T.td}><span className="flex min-w-0 flex-col"><span className="font-medium">{m.name}</span>{m.title && <span className="text-xs text-subtle">{m.title}</span>}</span></td>
                    <td className={T.td}><StatusBadge state={m.disabledAt ? "paused" : "active"} label={m.disabledAt ? "Paused" : "Active"} /></td>
                    <td className={`${T.td} text-right`}><RelTime at={m.createdAt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
