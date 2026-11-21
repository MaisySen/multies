/** OPS1: types, calls and small cells shared by the Developer platform tabs (pages/console/developer*.tsx). */
import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "@/web/lib/api";
import { fullDate, timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";

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

/** Relative time with the exact time on hover. */
export function When({ at, never = "Never" }: { at: string | null; never?: string }) {
  if (!at) return <span className="text-subtle">{never}</span>;
  return <span className="whitespace-nowrap text-muted" title={fullDate(at)}>{timeAgo(at)}</span>;
}

export function WorkspaceLink({ id, name }: { id: string; name: string | null }) {
  return <Link to={`/console/workspaces/${encodeURIComponent(id)}`} className="font-medium text-fg hover:underline">{name || id}</Link>;
}

export function PersonLink({ id, email }: { id: string | null; email: string | null }) {
  if (!id) return <span className="text-subtle">Unknown</span>;
  return <Link to={`/console/users/${encodeURIComponent(id)}`} className="hover:underline">{email || id}</Link>;
}

/** "https://hooks.example.com" reads as "hooks.example.com". */
export function hostOf(url: string | null): string {
  if (!url) return "Removed endpoint";
  try { return new URL(url).host || url; } catch { return url; }
}

export const Mono = ({ children, className }: { children: ReactNode; className?: string }) => <span className={cn("font-mono text-xs", className)}>{children}</span>;

/** A workspace named in the address (?orgId=) narrows every tab to it; links from a workspace's page use this. */
export function useWorkspaceScope(): { orgId: string | null; params: Record<string, string> } {
  const [params] = useSearchParams();
  const orgId = params.get("orgId");
  return { orgId, params: orgId ? { orgId } : {} };
}
