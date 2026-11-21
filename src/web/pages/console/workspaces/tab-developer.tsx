/**
 * OPS1: the Developer tab of a workspace: API keys (prefix only, never the key), webhook endpoints (address masked)
 * and connected apps.
 */
import { Badge, tableStyles as T } from "@/web/components/ui/misc";
import { IconKey, IconPlug, IconWebhook } from "@/web/components/ui/icon";
import { EmptyBlock, ErrorBlock, LoadingBlock, Section, When, useWorkspacePart } from "./tab-shared";

interface ApiKey { id: string; name: string; prefix: string; scope: string; agentId: string | null; createdByEmail: string | null; lastUsedAt: string | null; createdAt: string }
interface Endpoint { id: string; url: string; host: string; description: string | null; events: string[]; enabled: boolean; consecutiveDead: number; disabledReason: string | null; format: string; createdAt: string }
interface Grant { id: string; clientName: string | null; userId: string; userEmail: string | null; scope: "full" | "read"; lastUsedAt: string | null; revokedAt: string | null; createdAt: string }
interface DeveloperData { apiKeys: ApiKey[]; webhookEndpoints: Endpoint[]; oauthGrants: Grant[]; truncated: { apiKeys: boolean; webhookEndpoints: boolean; oauthGrants: boolean } }

const capped = (t: boolean) => (t ? "Showing the newest 500." : undefined);

export function WorkspaceDeveloperTab({ orgId }: { orgId: string }) {
  const q = useWorkspacePart<DeveloperData>(orgId, "developer");
  if (q.isPending) return <LoadingBlock />;
  if (q.error) return <ErrorBlock error={q.error} retry={() => void q.refetch()} />;
  const d = q.data;
  return (
    <div className="space-y-6" data-testid="console-workspaces-developer">
      <Section title="API keys" description={capped(d.truncated.apiKeys)}>
        {!d.apiKeys.length ? <EmptyBlock icon={<IconKey />} title="No API keys" body="Nobody in this workspace has made an API key." /> : (
          <div className={T.wrap} tabIndex={0} role="region" aria-label="API keys">
            <table className={T.table}>
              <thead className={T.head}><tr><th className={T.th}>Name</th><th className={T.th}>Starts with</th><th className={T.th}>Access</th><th className={T.th}>Made by</th><th className={T.th}>Last used</th><th className={`${T.th} text-right`}>Made</th></tr></thead>
              <tbody className={T.body}>
                {d.apiKeys.map((k) => (
                  <tr key={k.id} className={T.row}>
                    <td className={`${T.td} font-medium`}>{k.name}{k.agentId && <Badge className="ml-2">Agent</Badge>}</td>
                    <td className={`${T.td} font-mono text-xs`}>{k.prefix}</td>
                    <td className={T.td}>{k.scope}</td>
                    <td className={`${T.td} [overflow-wrap:anywhere]`}>{k.createdByEmail ?? <span className="text-subtle">Unknown</span>}</td>
                    <td className={T.td}><When at={k.lastUsedAt} /></td>
                    <td className={`${T.td} text-right`}><When at={k.createdAt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section title="Webhook endpoints" description={capped(d.truncated.webhookEndpoints) ?? "Addresses are shortened, as the rest is often a secret."}>
        {!d.webhookEndpoints.length ? <EmptyBlock icon={<IconWebhook />} title="No webhook endpoints" body="This workspace sends no webhooks." /> : (
          <div className={T.wrap} tabIndex={0} role="region" aria-label="Webhook endpoints">
            <table className={T.table}>
              <thead className={T.head}><tr><th className={T.th}>Address</th><th className={T.th}>Status</th><th className={`${T.th} text-right`}>Events</th><th className={`${T.th} text-right`}>Added</th></tr></thead>
              <tbody className={T.body}>
                {d.webhookEndpoints.map((w) => (
                  <tr key={w.id} className={T.row}>
                    <td className={T.td}><span className="flex flex-col"><span className="font-mono text-xs [overflow-wrap:anywhere]">{w.url}</span>{w.description && <span className="text-xs text-subtle">{w.description}</span>}</span></td>
                    <td className={T.td}>
                      {w.enabled
                        ? (w.consecutiveDead > 0 ? <Badge tone="warn" dot>Failing ({w.consecutiveDead})</Badge> : <Badge tone="ok" dot>On</Badge>)
                        : <Badge tone="bad" dot>Off</Badge>}
                      {!w.enabled && w.disabledReason && <span className="mt-0.5 block text-xs text-subtle">{w.disabledReason}</span>}
                    </td>
                    <td className={`${T.td} text-right tabular-nums`}>{w.events.length || "All"}</td>
                    <td className={`${T.td} text-right`}><When at={w.createdAt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section title="Connected apps" description={capped(d.truncated.oauthGrants)}>
        {!d.oauthGrants.length ? <EmptyBlock icon={<IconPlug />} title="No connected apps" body="Nobody in this workspace has connected an app." /> : (
          <div className={T.wrap} tabIndex={0} role="region" aria-label="Connected apps">
            <table className={T.table}>
              <thead className={T.head}><tr><th className={T.th}>App</th><th className={T.th}>Person</th><th className={T.th}>Access</th><th className={T.th}>Last used</th><th className={`${T.th} text-right`}>Connected</th></tr></thead>
              <tbody className={T.body}>
                {d.oauthGrants.map((g) => (
                  <tr key={g.id} className={T.row}>
                    <td className={`${T.td} font-medium`}>{g.clientName ?? "Unknown app"}{g.revokedAt && <Badge className="ml-2">Revoked</Badge>}</td>
                    <td className={`${T.td} [overflow-wrap:anywhere]`}>{g.userEmail ?? g.userId}</td>
                    <td className={T.td}>{g.scope === "read" ? "Read only" : "Full"}</td>
                    <td className={T.td}><When at={g.lastUsedAt} /></td>
                    <td className={`${T.td} text-right`}><When at={g.createdAt} /></td>
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
