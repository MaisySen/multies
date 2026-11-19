import { eq } from "drizzle-orm";
import type { Deps } from "../context";
import { operatorAccessAudit, users } from "../db/schema";
import { newId } from "../lib/crypto";

export type OperatorAccessAction = "role_change" | "sessions_revoked";
export type OperatorAccessAttempt = { id: string; targetId: string; action: OperatorAccessAction };

export function operatorAccessAction(path: string | undefined): OperatorAccessAction | undefined {
  if (path === "/admin/set-role") return "role_change";
  if (path === "/admin/revoke-user-sessions") return "sessions_revoked";
  return undefined;
}

export function hasOperatorRole(role: unknown): boolean {
  const names = Array.isArray(role) ? role : typeof role === "string" ? role.split(",") : [];
  return names.includes("admin");
}

// Record only recognised app principals, not the request body, headers, email or session identifiers.
export async function beginOperatorAccessAudit(deps: Deps, actorId: string, targetId: string,
  action: OperatorAccessAction, requestedRole: unknown): Promise<OperatorAccessAttempt | null> {
  const target = await deps.db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, targetId)).get();
  if (!target) return null;
  const id = newId("opa");
  await deps.db.insert(operatorAccessAudit).values({
    id, action, actorId, targetId: target.id,
    observedOperator: hasOperatorRole(target.role),
    requestedOperator: action === "role_change" ? hasOperatorRole(requestedRole) : null,
    requestedAt: deps.now(),
  });
  return { id, action, targetId: target.id };
}

export async function finishOperatorAccessAudit(deps: Deps, attempt: OperatorAccessAttempt, returned: unknown) {
  const result = returned as { user?: { id?: unknown }; success?: unknown } | null | undefined;
  const confirmed = attempt.action === "role_change" ? result?.user?.id === attempt.targetId : result?.success === true;
  // A failed completion write leaves the separately persisted intent unresolved, not a false success or failure.
  await deps.db.update(operatorAccessAudit).set({ outcome: confirmed ? "applied" : "unconfirmed", finishedAt: deps.now() })
    .where(eq(operatorAccessAudit.id, attempt.id));
}
