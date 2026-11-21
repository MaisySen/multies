/** OPS1: the Agents tab of a workspace: its agent inboxes and AI agent members. */
import { Badge, tableStyles as T } from "@/web/components/ui/misc";
import { IconAgent } from "@/web/components/ui/icon";
import { EmptyBlock, ErrorBlock, LoadingBlock, Section, When, useWorkspacePart } from "./tab-shared";

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
  if (q.error) return <ErrorBlock error={q.error} retry={() => void q.refetch()} />;
  const { agents, agentMembers, truncated } = q.data;
  return (
    <div className="space-y-6" data-testid="console-workspaces-agents">
      <Section title="Agent inboxes" description={truncated.agents ? "Showing the newest 500." : "Inboxes that AI agents use through the API and MCP."}>
        {!agents.length ? <EmptyBlock icon={<IconAgent />} title="No agent inboxes" body="This workspace has not set up an agent inbox." /> : (
          <div className={T.wrap} tabIndex={0} role="region" aria-label="Agent inboxes">
            <table className={T.table}>
              <thead className={T.head}><tr><th className={T.th}>Agent</th><th className={T.th}>Status</th><th className={T.th}>Needs approval</th><th className={`${T.th} text-right`}>Daily cap</th><th className={`${T.th} text-right`}>API keys</th><th className={`${T.th} text-right`}>Added</th></tr></thead>
              <tbody className={T.body}>
                {agents.map((a) => (
                  <tr key={a.id} className={T.row}>
                    <td className={T.td}><span className="flex flex-col"><span className="font-medium">{a.name}</span>{a.address && <span className="text-xs text-subtle [overflow-wrap:anywhere]">{a.address}</span>}</span></td>
                    <td className={T.td}><Badge tone={a.status === "active" ? "ok" : "warn"} dot>{a.status === "active" ? "Active" : "Paused"}</Badge></td>
                    <td className={T.td}>{APPROVAL[a.approvalMode]}{a.allowedRecipients && <span className="block text-xs text-subtle">Only {a.allowedRecipients.length} allowed recipients</span>}</td>
                    <td className={`${T.td} text-right tabular-nums`}>{a.sendCapDaily.toLocaleString()}</td>
                    <td className={`${T.td} text-right tabular-nums`}>{a.apiKeys}</td>
                    <td className={`${T.td} text-right`}><When at={a.createdAt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section title="Agent members" description={truncated.agentMembers ? "Showing the newest 500." : "AI teammates in People. They take no seat."}>
        {!agentMembers.length ? <EmptyBlock icon={<IconAgent />} title="No agent members" body="This workspace has no AI agent members." /> : (
          <div className={T.wrap} tabIndex={0} role="region" aria-label="Agent members">
            <table className={T.table}>
              <thead className={T.head}><tr><th className={T.th}>Name</th><th className={T.th}>Status</th><th className={`${T.th} text-right`}>Added</th></tr></thead>
              <tbody className={T.body}>
                {agentMembers.map((m) => (
                  <tr key={m.id} className={T.row}>
                    <td className={T.td}><span className="flex flex-col"><span className="font-medium">{m.name}</span>{m.title && <span className="text-xs text-subtle">{m.title}</span>}</span></td>
                    <td className={T.td}><Badge tone={m.disabledAt ? "warn" : "ok"} dot>{m.disabledAt ? "Paused" : "Active"}</Badge></td>
                    <td className={`${T.td} text-right`}><When at={m.createdAt} /></td>
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
