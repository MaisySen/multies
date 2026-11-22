/**
 * OPS1: the owner's email under a workspace's name in console lists, which is what an operator recognises (two
 * workspaces can share a name). One statement per page of results, whatever its size: the page's workspace ids go in
 * through `inIds` (one bound variable past 20 ids, so never near D1's 100 variable limit) and members is read through
 * members_org_user_uq, which leads on organization_id. Never a lookup per row. Reads only.
 */
import { and, asc, eq } from "drizzle-orm";
import type { Deps } from "../../context";
import { members, users } from "../../db/schema";
import { inIds } from "../../lib/sql-chunks";

/** Each workspace's first owner's email (the earliest owner membership), for the given ids. Missing: no owner row. */
export async function ownerEmails(deps: Deps, orgIds: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const ids = [...new Set(orgIds.filter((id): id is string => !!id))];
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const rows = await deps.db.select({ orgId: members.organizationId, email: users.email }).from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(inIds(members.organizationId, ids), eq(members.role, "owner")))
    .orderBy(asc(members.organizationId), asc(members.createdAt), asc(members.id));
  for (const r of rows) if (!out.has(r.orgId)) out.set(r.orgId, r.email);
  return out;
}

/** The items with `ownerEmail` added (null when the workspace has no owner), in one lookup for the whole page. */
export async function withOwnerEmail<T extends { orgId: string | null }>(deps: Deps, items: T[]): Promise<(T & { ownerEmail: string | null })[]> {
  const emails = await ownerEmails(deps, items.map((i) => i.orgId));
  return items.map((i) => ({ ...i, ownerEmail: (i.orgId && emails.get(i.orgId)) || null }));
}
