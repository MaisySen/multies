/**
 * OPS1: the operator console's "Developer platform" data layer. Cross-workspace views over API keys, webhook
 * endpoints and deliveries, OAuth clients and grants, plus the data mutations the route layer wraps with its
 * permission guard, reason and platform audit row. Mutations reuse the workspace services in services/developer.
 *
 * Never returned: an API key or its hash, a webhook signing secret, an OAuth code, refresh token or their hashes, a
 * PKCE challenge, or a webhook payload's values (only its event type and the names of its top-level data fields).
 */
import { and, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { apiKeys, oauthClients, oauthGrants, organizations, users, webhookDeliveries, webhookEndpoints } from "../../db/schema";
import { badRequest } from "../../lib/errors";
import { containsAny } from "../../lib/like-search";
import { inIds } from "../../lib/sql-chunks";
import { newestRows } from "./recent-rows";
import { deleteApiKey } from "../developer/api-keys";
import { revokeGrant } from "../developer/oauth";
import { replayFailed, updateEndpoint } from "../developer/webhooks";
import { clampLimit, clip, found, keysetAfter, keysetOrder, ms, pageOf, resolveWindow, sortSpec, timeKey, withOwners, type Page, type PageRequest, type SortSpec, type TimeWindow } from "./mail";

// ---------------------------------------------------------------- API keys

export const API_KEY_SORT_FIELDS = ["createdAt", "lastUsedAt", "name"] as const;
export type ApiKeySortField = (typeof API_KEY_SORT_FIELDS)[number];
const keySorts: Record<ApiKeySortField, SortSpec> = {
  createdAt: { expr: sql`${apiKeys.createdAt}`, kind: "number" },
  lastUsedAt: { expr: timeKey(apiKeys.lastUsedAt), kind: "number" },
  name: { expr: sql`${apiKeys.name}`, kind: "text" },
};

export interface ApiKeyFilters {
  orgId?: string;
  /** Only keys that act as this agent. */
  agentId?: string;
  /** Part of the name or the prefix. */
  q?: string;
}

/**
 * An API key as an operator sees it: never the key or its hash. Keys have no revoked state: deleting a key (the
 * workspace's Delete, or `revokeApiKey`) removes its row, so every listed key works.
 */
export interface ConsoleApiKey {
  id: string; orgId: string; orgName: string | null; ownerEmail: string | null; name: string; prefix: string;
  /** "full", "read" or a space separated list of per area scopes. */
  scope: string; agentId: string | null;
  createdByUserId: string | null; createdByEmail: string | null;
  lastUsedAt: Date | null; createdAt: Date;
}

/** Index: `api_keys_org_idx (org_id)` with `orgId`; otherwise a scan of `api_keys` (at most 25 per workspace). */
export async function listApiKeys(deps: Deps, filters: ApiKeyFilters, page: PageRequest): Promise<Page<ConsoleApiKey>> {
  const spec = sortSpec(keySorts, page.sort.field);
  const limit = clampLimit(page.limit);
  const q = filters.q?.trim();
  const k = apiKeys;
  const rows = await deps.db.select({
    id: k.id, orgId: k.orgId, name: k.name, prefix: k.prefix, scope: k.scope, agentId: k.agentId, createdByUserId: k.createdByUserId,
    lastUsedAt: k.lastUsedAt, createdAt: k.createdAt, orgName: organizations.name, createdByEmail: users.email,
  }).from(k)
    .leftJoin(organizations, eq(organizations.id, k.orgId))
    .leftJoin(users, eq(users.id, k.createdByUserId))
    .where(and(
      filters.orgId ? eq(k.orgId, filters.orgId) : undefined,
      filters.agentId ? eq(k.agentId, filters.agentId) : undefined,
      q ? containsAny([k.name, k.prefix], q) : undefined,
      keysetAfter(spec, k.id, page.sort.dir, page.cursor),
    ))
    .orderBy(...keysetOrder(spec, k.id, page.sort.dir)).limit(limit + 1);
  return withOwners(deps, pageOf(rows, limit, (r) => ({ ...r, createdByEmail: r.createdByEmail ?? null }),
    (r) => ({ v: page.sort.field === "name" ? r.name : ms(page.sort.field === "lastUsedAt" ? r.lastUsedAt : r.createdAt), id: r.id })));
}

export interface RevokedApiKey { id: string; orgId: string; name: string; prefix: string }

/** Deletes the key (the workspace's own deleteApiKey): requests with it are refused from the next call. */
export async function revokeApiKey(deps: Deps, id: string): Promise<RevokedApiKey> {
  const k = found(await deps.db.select({ orgId: apiKeys.orgId }).from(apiKeys).where(eq(apiKeys.id, id)).get(), "API key");
  const out = await deleteApiKey(deps, k.orgId, id);
  return { id: out.id, orgId: k.orgId, name: out.name, prefix: out.prefix };
}

// ---------------------------------------------------------------- webhook endpoints

export const WEBHOOK_ENDPOINT_SORT_FIELDS = ["createdAt", "url"] as const;
export type WebhookEndpointSortField = (typeof WEBHOOK_ENDPOINT_SORT_FIELDS)[number];
const endpointSorts: Record<WebhookEndpointSortField, SortSpec> = {
  createdAt: { expr: sql`${webhookEndpoints.createdAt}`, kind: "number" },
  url: { expr: sql`${webhookEndpoints.url}`, kind: "text" },
};

export interface WebhookEndpointFilters {
  orgId?: string; enabled?: boolean;
  /** Part of the URL or description. */
  q?: string;
  /** The window `recentFailures` counts over; defaults to the last 7 days. */
  failuresWindow?: TimeWindow;
}

/** A webhook endpoint. Never its signing secret. */
export interface ConsoleWebhookEndpoint {
  id: string; orgId: string; orgName: string | null; ownerEmail: string | null; url: string; description: string | null; events: string[];
  format: "json" | "slack" | "discord" | "teams"; connector: string | null; enabled: boolean; disabledReason: string | null;
  /** Deliveries in a row that ran out of retries (the endpoint is switched off at 5). */
  consecutiveDead: number;
  /** Deliveries that ran out of retries in `failuresWindow`. */
  recentFailures: number;
  createdAt: Date;
}

/**
 * Index: `webhook_endpoints_org_idx (org_id)` with `orgId`, otherwise a scan of `webhook_endpoints` (at most 10 per
 * workspace). The failure counts read `webhook_deliveries_endpoint_idx (endpoint_id, created_at)` for the page's ids.
 */
export async function listWebhookEndpoints(deps: Deps, filters: WebhookEndpointFilters, page: PageRequest): Promise<Page<ConsoleWebhookEndpoint>> {
  const spec = sortSpec(endpointSorts, page.sort.field);
  const limit = clampLimit(page.limit);
  const { from, to } = resolveWindow(deps, filters.failuresWindow);
  const q = filters.q?.trim();
  const e = webhookEndpoints;
  const rows = await deps.db.select({
    id: e.id, orgId: e.orgId, url: e.url, description: e.description, events: e.events, format: e.format, connector: e.connector,
    enabled: e.enabled, disabledReason: e.disabledReason, consecutiveDead: e.consecutiveDead, createdAt: e.createdAt, orgName: organizations.name,
  }).from(e)
    .leftJoin(organizations, eq(organizations.id, e.orgId))
    .where(and(
      filters.orgId ? eq(e.orgId, filters.orgId) : undefined,
      filters.enabled !== undefined ? eq(e.enabled, filters.enabled) : undefined,
      q ? containsAny([e.url, e.description], q) : undefined,
      keysetAfter(spec, e.id, page.sort.dir, page.cursor),
    ))
    .orderBy(...keysetOrder(spec, e.id, page.sort.dir)).limit(limit + 1);
  const ids = rows.slice(0, limit).map((r) => r.id);
  const counts = ids.length
    ? await deps.db.select({ endpointId: webhookDeliveries.endpointId, n: sql<number>`count(*)` }).from(webhookDeliveries)
      .where(and(inIds(webhookDeliveries.endpointId, ids), gte(webhookDeliveries.createdAt, from), lt(webhookDeliveries.createdAt, to), eq(webhookDeliveries.status, "failed")))
      .groupBy(webhookDeliveries.endpointId)
    : [];
  const failures = new Map(counts.map((c) => [c.endpointId, Number(c.n)]));
  return withOwners(deps, pageOf(rows, limit, (r) => ({
    ...r, events: parseEvents(r.events), format: r.format ?? "json", disabledReason: clip(r.disabledReason), recentFailures: failures.get(r.id) ?? 0,
  }), (r) => ({ v: page.sort.field === "url" ? r.url : ms(r.createdAt), id: r.id })));
}

function parseEvents(raw: string): string[] {
  try { const v = JSON.parse(raw) as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
}

export interface WebhookEndpointEnabledResult { id: string; orgId: string; url: string; before: { enabled: boolean }; enabled: boolean }

/** Switches an endpoint off or back on (the workspace's own updateEndpoint). */
export async function setWebhookEndpointEnabled(deps: Deps, id: string, enabled: boolean): Promise<WebhookEndpointEnabledResult> {
  const e = found(await deps.db.select({ orgId: webhookEndpoints.orgId, enabled: webhookEndpoints.enabled }).from(webhookEndpoints).where(eq(webhookEndpoints.id, id)).get(), "Webhook endpoint");
  const out = await updateEndpoint(deps, e.orgId, id, { enabled });
  return { id: out.id, orgId: e.orgId, url: out.url, before: { enabled: e.enabled }, enabled: out.enabled };
}

// ---------------------------------------------------------------- webhook deliveries

export type WebhookDeliveryStatus = (typeof webhookDeliveries.$inferSelect)["status"];
export const WEBHOOK_DELIVERY_SORT_FIELDS = ["createdAt"] as const;
export type WebhookDeliverySortField = (typeof WEBHOOK_DELIVERY_SORT_FIELDS)[number];
const deliverySorts: Record<WebhookDeliverySortField, SortSpec> = { createdAt: { expr: sql`${webhookDeliveries.createdAt}`, kind: "number" } };

export interface WebhookDeliveryFilters {
  /** Defaults to ["failed"] (retries ran out). */
  status?: WebhookDeliveryStatus[];
  orgId?: string; endpointId?: string; eventType?: string;
  /** Defaults to the last 7 days. */
  window?: TimeWindow;
}

/** One delivery series. The payload is never returned: only the names of its top-level data fields. */
export interface ConsoleWebhookDelivery {
  id: string; orgId: string; orgName: string | null; ownerEmail: string | null; endpointId: string; endpointUrl: string | null; eventType: string;
  status: WebhookDeliveryStatus; attempts: number; responseStatus: number | null; lastError: string | null;
  /** e.g. "message.bounced: id, mailboxId, to" (field names only, at most 120 characters). */
  payloadPreview: string;
  nextAttemptAt: Date | null; deliveredAt: Date | null; createdAt: Date;
}

/**
 * Index: with `endpointId`, or `orgId` (resolved to that workspace's endpoint ids, at most 10), the window and order
 * use `webhook_deliveries_endpoint_idx (endpoint_id, created_at)`. With neither, failed or pending (rare: dead letters
 * and retries in flight) come from `webhook_deliveries_due_idx (status, next_attempt_at)`. Delivered ones across every
 * workspace look at the newest RECENT_ROWS_CAP deliveries only (recent-rows.ts; an index here would cost a row write
 * per webhook event).
 */
export async function listWebhookDeliveries(deps: Deps, filters: WebhookDeliveryFilters, page: PageRequest): Promise<Page<ConsoleWebhookDelivery>> {
  const spec = sortSpec(deliverySorts, page.sort.field);
  const limit = clampLimit(page.limit);
  const { from, to } = resolveWindow(deps, filters.window);
  const statuses = filters.status?.length ? filters.status : (["failed"] as WebhookDeliveryStatus[]);
  for (const s of statuses) if (!["pending", "delivered", "failed"].includes(s)) throw badRequest(`Unknown delivery status "${s}".`);
  let endpointIds: string[] | null = filters.endpointId ? [filters.endpointId] : null;
  if (filters.orgId && !filters.endpointId) {
    endpointIds = (await deps.db.select({ id: webhookEndpoints.id }).from(webhookEndpoints).where(eq(webhookEndpoints.orgId, filters.orgId))).map((r) => r.id);
    if (!endpointIds.length) return { items: [], next: null };
  }
  const d = webhookDeliveries;
  const recentOnly = !endpointIds && statuses.includes("delivered");
  const rows = await deps.db.select({
    id: d.id, orgId: d.orgId, endpointId: d.endpointId, eventType: d.eventType, status: d.status, attempts: d.attempts, responseStatus: d.responseStatus,
    lastError: d.lastError, nextAttemptAt: d.nextAttemptAt, deliveredAt: d.deliveredAt, createdAt: d.createdAt,
    // Only the top-level data keys leave the database, never the values.
    dataKeys: sql<string | null>`(select group_concat(key, ', ') from json_each(${d.payload}, '$.data'))`,
    orgName: organizations.name, endpointUrl: webhookEndpoints.url,
  }).from(d)
    .leftJoin(organizations, eq(organizations.id, d.orgId))
    .leftJoin(webhookEndpoints, eq(webhookEndpoints.id, d.endpointId))
    .where(and(
      endpointIds ? inIds(d.endpointId, endpointIds) : undefined,
      filters.orgId ? eq(d.orgId, filters.orgId) : undefined,
      gte(d.createdAt, from), lt(d.createdAt, to),
      // Delivered across every workspace: the newest rows only. The unary + keeps SQLite off webhook_deliveries_due_idx
      // there, which would read every delivered row.
      ...(recentOnly ? [inIds(sql`+${d.status}`, statuses), newestRows(d)] : [inIds(d.status, statuses)]),
      filters.eventType ? eq(d.eventType, filters.eventType) : undefined,
      keysetAfter(spec, d.id, page.sort.dir, page.cursor),
    ))
    .orderBy(...keysetOrder(spec, d.id, page.sort.dir)).limit(limit + 1);
  const out = await withOwners(deps, pageOf(rows, limit, ({ dataKeys, ...r }) => ({
    ...r, endpointUrl: r.endpointUrl ?? null, lastError: clip(r.lastError),
    payloadPreview: `${r.eventType}${dataKeys ? `: ${dataKeys}` : ""}`.slice(0, 120),
  }), (r) => ({ v: ms(r.createdAt), id: r.id })));
  return recentOnly ? { ...out, recentOnly } : out;
}

export interface RedeliverResult { id: string; orgId: string; endpointId: string; replayed: number }

/**
 * Sends one failed (dead-letter) delivery again now, through the workspace's own replayFailed. As there, replaying
 * switches a disabled endpoint back on and resets its dead-letter count.
 */
export async function redeliverWebhook(deps: Deps, deliveryId: string): Promise<RedeliverResult> {
  const d = found(await deps.db.select({ orgId: webhookDeliveries.orgId, endpointId: webhookDeliveries.endpointId, status: webhookDeliveries.status })
    .from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).get(), "Webhook delivery");
  if (d.status !== "failed") throw badRequest("Only a delivery that ran out of retries can be sent again.");
  const replayed = await replayFailed(deps, d.orgId, d.endpointId, [deliveryId]);
  return { id: deliveryId, orgId: d.orgId, endpointId: d.endpointId, replayed };
}

// ---------------------------------------------------------------- OAuth clients

export const OAUTH_CLIENT_SORT_FIELDS = ["createdAt", "name"] as const;
export type OAuthClientSortField = (typeof OAUTH_CLIENT_SORT_FIELDS)[number];
const clientSorts: Record<OAuthClientSortField, SortSpec> = {
  createdAt: { expr: sql`${oauthClients.createdAt}`, kind: "number" },
  name: { expr: sql`${oauthClients.name}`, kind: "text" },
};

export interface OAuthClientFilters { q?: string; window?: TimeWindow }

/** A registered OAuth client (Claude, ChatGPT, Cursor, ...). Clients are platform wide, so there is no workspace. */
export interface ConsoleOAuthClient { id: string; name: string; redirectUris: string[]; clientUri: string | null; createdAt: Date }

/**
 * `oauth_clients` has only its primary key (an index would cost a row write on every client registration, which is
 * open to anyone), so the list looks at the newest RECENT_ROWS_CAP registrations by rowid (recent-rows.ts) and then
 * applies the created_at window (default 90 days) or the name search.
 */
export async function listOAuthClients(deps: Deps, filters: OAuthClientFilters, page: PageRequest): Promise<Page<ConsoleOAuthClient>> {
  const spec = sortSpec(clientSorts, page.sort.field);
  const limit = clampLimit(page.limit);
  const q = filters.q?.trim();
  const w = q && !filters.window ? null : resolveWindow(deps, filters.window, 90);
  const c = oauthClients;
  const rows = await deps.db.select().from(c)
    .where(and(
      newestRows(c),
      w ? and(gte(c.createdAt, w.from), lt(c.createdAt, w.to)) : undefined,
      q ? containsAny([c.name, c.clientUri], q) : undefined,
      keysetAfter(spec, c.id, page.sort.dir, page.cursor),
    ))
    .orderBy(...keysetOrder(spec, c.id, page.sort.dir)).limit(limit + 1);
  const out = pageOf(rows, limit, (r) => ({ id: r.id, name: r.name, redirectUris: parseEvents(r.redirectUris), clientUri: r.clientUri, createdAt: r.createdAt }),
    (r) => ({ v: page.sort.field === "name" ? r.name : ms(r.createdAt), id: r.id }));
  // Always the newest registrations only (clients have no workspace to narrow by).
  return { ...out, recentOnly: true };
}

// ---------------------------------------------------------------- OAuth grants

export const OAUTH_GRANT_SORT_FIELDS = ["createdAt", "lastUsedAt"] as const;
export type OAuthGrantSortField = (typeof OAUTH_GRANT_SORT_FIELDS)[number];
const grantSorts: Record<OAuthGrantSortField, SortSpec> = {
  createdAt: { expr: sql`${oauthGrants.createdAt}`, kind: "number" },
  lastUsedAt: { expr: timeKey(oauthGrants.lastUsedAt), kind: "number" },
};

export interface OAuthGrantFilters {
  orgId?: string; userId?: string; clientId?: string;
  /** "active" (default): signed in and not revoked. "revoked": revoked ones. "all": both, plus codes never exchanged. */
  state?: "active" | "revoked" | "all";
  /** Applied when `orgId` is not given; then it defaults to the last 90 days. */
  window?: TimeWindow;
}

/** One person's sign in of an OAuth client to one workspace. Never the code, refresh token, their hashes or the PKCE challenge. */
export interface ConsoleOAuthGrant {
  id: string; orgId: string; orgName: string | null; ownerEmail: string | null; clientId: string; clientName: string | null;
  userId: string; userEmail: string | null; scope: "full" | "read"; redirectUri: string;
  lastUsedAt: Date | null; revokedAt: Date | null; createdAt: Date;
}

/**
 * Index: `oauth_grants_org_idx (org_id, user_id)` with `orgId` (and `userId`). Without a workspace there is no index
 * (one would cost a row write on every MCP sign in), so the list looks at the newest RECENT_ROWS_CAP grants by rowid
 * (recent-rows.ts), then applies the created_at window (default 90 days) and the client and state filters.
 */
export async function listOAuthGrants(deps: Deps, filters: OAuthGrantFilters, page: PageRequest): Promise<Page<ConsoleOAuthGrant>> {
  const spec = sortSpec(grantSorts, page.sort.field);
  const limit = clampLimit(page.limit);
  const w = filters.orgId && !filters.window ? null : resolveWindow(deps, filters.window, 90);
  const state = filters.state ?? "active";
  const g = oauthGrants;
  const rows = await deps.db.select({
    id: g.id, orgId: g.orgId, clientId: g.clientId, userId: g.userId, scope: g.scope, redirectUri: g.redirectUri,
    lastUsedAt: g.lastUsedAt, revokedAt: g.revokedAt, createdAt: g.createdAt,
    orgName: organizations.name, clientName: oauthClients.name, userEmail: users.email,
  }).from(g)
    .leftJoin(organizations, eq(organizations.id, g.orgId))
    .leftJoin(oauthClients, eq(oauthClients.id, g.clientId))
    .leftJoin(users, eq(users.id, g.userId))
    .where(and(
      filters.orgId ? eq(g.orgId, filters.orgId) : newestRows(g),
      filters.userId ? eq(g.userId, filters.userId) : undefined,
      filters.clientId ? eq(g.clientId, filters.clientId) : undefined,
      w ? and(gte(g.createdAt, w.from), lt(g.createdAt, w.to)) : undefined,
      state === "active" ? and(isNull(g.revokedAt), isNotNull(g.codeUsedAt)) : state === "revoked" ? isNotNull(g.revokedAt) : undefined,
      keysetAfter(spec, g.id, page.sort.dir, page.cursor),
    ))
    .orderBy(...keysetOrder(spec, g.id, page.sort.dir)).limit(limit + 1);
  const out = await withOwners(deps, pageOf(rows, limit, (r) => ({ ...r, clientName: r.clientName ?? null, userEmail: r.userEmail ?? null }),
    (r) => ({ v: ms(page.sort.field === "lastUsedAt" ? r.lastUsedAt : r.createdAt), id: r.id })));
  return filters.orgId ? out : { ...out, recentOnly: true };
}

export interface RevokedOAuthGrant { id: string; orgId: string; clientId: string; userId: string }

/** Disconnects the app (the workspace's own revokeGrant, acting with workspace admin rights): its tokens stop working. */
export async function revokeOAuthGrant(deps: Deps, id: string): Promise<RevokedOAuthGrant> {
  const row = found(await deps.db.select({ orgId: oauthGrants.orgId }).from(oauthGrants).where(eq(oauthGrants.id, id)).get(), "Connected app");
  const g = await revokeGrant(deps, { orgId: row.orgId, userId: "", role: "admin" }, id);
  return { id: g.id, orgId: g.orgId, clientId: g.clientId, userId: g.userId };
}

// ---------------------------------------------------------------- audit targets

export type DeveloperTargetKind = "apiKey" | "webhookEndpoint" | "webhookDelivery" | "oauthGrant";

/**
 * The workspace a target belongs to, read before a change so the route can name it in the platform and workspace
 * audit rows. A primary key read; an unknown id is a 404 named like the change's own.
 */
export async function developerTargetOrg(deps: Deps, kind: DeveloperTargetKind, id: string): Promise<string> {
  const db = deps.db;
  const row = kind === "apiKey" ? await db.select({ orgId: apiKeys.orgId }).from(apiKeys).where(eq(apiKeys.id, id)).get()
    : kind === "webhookEndpoint" ? await db.select({ orgId: webhookEndpoints.orgId }).from(webhookEndpoints).where(eq(webhookEndpoints.id, id)).get()
      : kind === "webhookDelivery" ? await db.select({ orgId: webhookDeliveries.orgId }).from(webhookDeliveries).where(eq(webhookDeliveries.id, id)).get()
        : await db.select({ orgId: oauthGrants.orgId }).from(oauthGrants).where(eq(oauthGrants.id, id)).get();
  const what = { apiKey: "API key", webhookEndpoint: "Webhook endpoint", webhookDelivery: "Webhook delivery", oauthGrant: "Connected app" }[kind];
  return found(row, what).orgId;
}
