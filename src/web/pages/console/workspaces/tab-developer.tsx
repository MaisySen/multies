/**
 * OPS1: the Developer tab of a workspace: API keys (prefix only, never the key), webhook endpoints (address masked)
 * and connected apps. An empty section is one line.
 */
import { Badge } from "@/web/components/ui/misc";
import { IconKey, IconPlug, IconWebhook } from "@/web/components/ui/icon";
import { consoleTable as T } from "../components/data-table";
import { Empty, EmptyRow, LoadError, PersonLink, RelTime, StatusBadge, humanize } from "../components/format";
import { LoadingBlock, Section, useWorkspacePart } from "./tab-shared";

interface ApiKey { id: string; name: string; prefix: string; scope: string; agentId: string | null; createdByEmail: string | null; lastUsedAt: string | null; createdAt: string }
interface Endpoint { id: string; url: string; host: string; description: string | null; events: string[]; enabled: boolean; consecutiveDead: number; disabledReason: string | null; format: string; createdAt: string }
interface Grant { id: string; clientName: string | null; userId: string; userEmail: string | null; scope: "full" | "read"; lastUsedAt: string | null; revokedAt: string | null; createdAt: string }
interface DeveloperData { apiKeys: ApiKey[]; webhookEndpoints: Endpoint[]; oauthGrants: Grant[]; truncated: { apiKeys: boolean; webhookEndpoints: boolean; oauthGrants: boolean } }

const capped = (t: boolean) => (t ? "Showing the newest 500." : undefined);

export function WorkspaceDeveloperTab({ orgId }: { orgId: string }) {
  const q = useWorkspacePart<DeveloperData>(orgId, "developer");
  if (q.isPending) return <LoadingBlock />;
  if (q.error) return <LoadError error={q.error} retry={() => void q.refetch()} what="the developer details" />;
  const d = q.data;
  return (
    <div className="space-y-6" data-testid="console-workspaces-developer">
      <Section title="API keys" description={capped(d.truncated.apiKeys)}>
        {!d.apiKeys.length ? <EmptyRow icon={<IconKey />}>No API keys. Nobody in this workspace has made one.</EmptyRow> : (
          <div className={T.wrap} tabIndex={0} role="region" aria-label="API keys">
            <table className={T.table}>
              <thead className={T.head}><tr><th className={T.th}>Name</th><th className={T.th}>Starts with</th><th className={`${T.th} ${T.secondary}`}>Access</th><th className={`${T.th} ${T.secondary}`}>Made by</th><th className={T.th}>Last used</th><th className={`${T.th} ${T.secondary} text-right`}>Made</th></tr></thead>
              <tbody className={T.body}>
                {d.apiKeys.map((k) => (
                  <tr key={k.id} className={T.row}>
                    <td className={`${T.td} font-medium`}><span className="inline-flex flex-wrap items-center gap-2">{k.name}{k.agentId && <Badge className="whitespace-nowrap">Agent</Badge>}</span></td>
                    <td className={`${T.td} whitespace-nowrap font-mono text-xs`}>{k.prefix}</td>
                    <td className={`${T.td} ${T.secondary}`}><span title={k.scope}>{humanize(k.scope)}</span></td>
                    <td className={`${T.td} ${T.secondary}`}>{k.createdByEmail ?? <Empty>Unknown</Empty>}</td>
                    <td className={T.td}><RelTime at={k.lastUsedAt} /></td>
                    <td className={`${T.td} ${T.secondary} text-right`}><RelTime at={k.createdAt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section title="Webhook endpoints" description={capped(d.truncated.webhookEndpoints) ?? "Addresses are shortened, as the rest is often a secret."}>
        {!d.webhookEndpoints.length ? <EmptyRow icon={<IconWebhook />}>No webhook endpoints. This workspace sends no webhooks.</EmptyRow> : (
          <div className={T.wrap} tabIndex={0} role="region" aria-label="Webhook endpoints">
            <table className={T.table}>
              <thead className={T.head}><tr><th className={T.th}>Address</th><th className={T.th}>Status</th><th className={`${T.th} text-right`}>Events</th><th className={`${T.th} ${T.secondary} text-right`}>Added</th></tr></thead>
              <tbody className={T.body}>
                {d.webhookEndpoints.map((w) => (
                  <tr key={w.id} className={T.row}>
                    <td className={T.td}><span className="flex min-w-0 flex-col"><span className="break-all font-mono text-xs">{w.url}</span>{w.description && <span className="text-xs text-subtle">{w.description}</span>}</span></td>
                    <td className={T.td}>
                      {w.enabled
                        ? (w.consecutiveDead > 0 ? <StatusBadge state="failing" tone="warn" label={`Failing (${w.consecutiveDead})`} /> : <StatusBadge state="on" label="On" />)
                        : <StatusBadge state="disabled" label="Off" />}
                      {!w.enabled && w.disabledReason && <span className="mt-0.5 block text-xs text-subtle">{w.disabledReason}</span>}
                    </td>
                    <td className={`${T.td} text-right tabular-nums`}>{w.events.length || "All"}</td>
                    <td className={`${T.td} ${T.secondary} text-right`}><RelTime at={w.createdAt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section title="Connected apps" description={capped(d.truncated.oauthGrants)}>
        {!d.oauthGrants.length ? <EmptyRow icon={<IconPlug />}>No connected apps. Nobody in this workspace has connected one.</EmptyRow> : (
          <div className={T.wrap} tabIndex={0} role="region" aria-label="Connected apps">
            <table className={T.table}>
              <thead className={T.head}><tr><th className={T.th}>App</th><th className={T.th}>Person</th><th className={`${T.th} ${T.secondary}`}>Access</th><th className={T.th}>Last used</th><th className={`${T.th} ${T.secondary} text-right`}>Connected</th></tr></thead>
              <tbody className={T.body}>
                {d.oauthGrants.map((g) => (
                  <tr key={g.id} className={T.row}>
                    <td className={`${T.td} font-medium`}><span className="inline-flex flex-wrap items-center gap-2">{g.clientName ?? "Unknown app"}{g.revokedAt && <StatusBadge state="revoked" label="Revoked" />}</span></td>
                    <td className={T.td}><PersonLink id={g.userId} email={g.userEmail} /></td>
                    <td className={`${T.td} ${T.secondary}`}>{g.scope === "read" ? "Read only" : "Full"}</td>
                    <td className={T.td}><RelTime at={g.lastUsedAt} /></td>
                    <td className={`${T.td} ${T.secondary} text-right`}><RelTime at={g.createdAt} /></td>
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
