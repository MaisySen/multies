/** OPS1: types, calls and small cells shared by the Developer platform tabs (pages/console/developer*.tsx). */
import type { ReactNode } from "react";
import { useSearchParams } from "react-router";
import { api } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { EMPTY, WorkspaceLink } from "./components/format";

// ---------------------------------------------------------------- what the server answers (dates as ISO strings)

export interface DevApiKey {
  id: string; orgId: string; orgName: string | null; name: string; prefix: string; scope: string; agentId: string | null;
  createdByUserId: string | null; createdByEmail: string | null; lastUsedAt: string | null; createdAt: string;
}

export interface DevWebhookEndpoint {
  id: string; orgId: string; orgName: string | null;
  /** Only the address's origin (its path can hold a token). */
  url: string; description: string | null; events: string[];
  format: "json" | "slack" | "discord" | "teams"; connector: string | null; enabled: boolean; disabledReason: string | null;
  consecutiveDead: number; recentFailures: number; createdAt: string;
}

export interface DevWebhookDelivery {
  id: string; orgId: string; orgName: string | null; endpointId: string; endpointUrl: string | null; eventType: string;
  status: "pending" | "delivered" | "failed"; attempts: number; responseStatus: number | null; lastError: string | null;
  /** "<event type>: <field names>" (never values). */
  payloadPreview: string; nextAttemptAt: string | null; deliveredAt: string | null; createdAt: string;
}

export interface DevOAuthClient { id: string; name: string; redirectUris: string[]; clientUri: string | null; createdAt: string }

export interface DevOAuthGrant {
  id: string; orgId: string; orgName: string | null; clientId: string; clientName: string | null;
  userId: string; userEmail: string | null; scope: "full" | "read"; redirectUri: string;
  lastUsedAt: string | null; revokedAt: string | null; createdAt: string;
}

// ---------------------------------------------------------------- changes (each with the operator's reason)

const enc = encodeURIComponent;
export const developerApi = {
  revokeApiKey: (id: string, reason: string) => api.post<{ ok: true }>(`/console/developer/api-keys/${enc(id)}/revoke`, { reason }),
  setEndpointEnabled: (id: string, enabled: boolean, reason: string) =>
    api.post<{ ok: true; enabled: boolean }>(`/console/developer/webhooks/${enc(id)}/${enabled ? "enable" : "disable"}`, { reason }),
  redeliver: (id: string, reason: string) => api.post<{ ok: true; replayed: number }>(`/console/developer/webhook-deliveries/${enc(id)}/redeliver`, { reason }),
  revokeGrant: (id: string, reason: string) => api.post<{ ok: true }>(`/console/developer/oauth-grants/${enc(id)}/revoke`, { reason }),
};

// ---------------------------------------------------------------- cells

/** A workspace name that opens it in the console, with a short id under it so two of one name can be told apart. */
export function Workspace({ id, name }: { id: string; name: string | null }) {
  return <WorkspaceLink id={id} name={name} hint={id.replace(/^org_/, "").slice(0, 8)} />;
}

/** "https://hooks.example.com" reads as "hooks.example.com". */
export function hostOf(url: string | null): string {
  if (!url) return "Removed endpoint";
  try { return new URL(url).host || url; } catch { return url; }
}

/** The field names of a delivery's preview ("message.bounced: id, to" -> "id, to"); EMPTY when it names none. */
export function fieldNames(d: Pick<DevWebhookDelivery, "eventType" | "payloadPreview">): string {
  const p = d.payloadPreview ?? "";
  const rest = p.startsWith(d.eventType) ? p.slice(d.eventType.length).replace(/^:\s*/, "") : p;
  return rest.trim() || EMPTY;
}

export const Mono = ({ children, className }: { children: ReactNode; className?: string }) => <span className={cn("font-mono text-xs", className)}>{children}</span>;

/** A workspace named in the address (?orgId=) narrows every tab to it; links from a workspace's page use this. */
export function useWorkspaceScope(): { orgId: string | null; params: Record<string, string> } {
  const [params] = useSearchParams();
  const orgId = params.get("orgId");
  return { orgId, params: orgId ? { orgId } : {} };
}
