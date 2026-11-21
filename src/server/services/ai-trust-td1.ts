/**
 * TD1 AI trust controls (flag ASK_TD1). AI is on in every workspace, new and existing, until an admin turns it off
 * (no ai_trust row means on). AI off means no provider call:
 * every place that calls a model asks aiAllowed first. Flag off: aiAllowed is always true, so nothing changes.
 * Settings > AI names the provider in use and where it runs, for admins and members alike.
 */
import { eq } from "drizzle-orm";
import type { Deps } from "../context";
import { aiKeys, aiTrust } from "../db/schema";
import { HttpError } from "../lib/errors";
import { audit } from "./audit";
import { keyFallbackOn } from "./ai/keys"; // QUAL1
import { AI_OFF_MESSAGE, whereOf } from "@/shared/ask-td1";
import { featureOn } from "./console/flags"; // OPS1 feature flags

export interface AiTrustState {
  /** Whether the trust controls are live (ASK_TD1). */
  controls: boolean;
  on: boolean;
  /** "admin" when an admin decided, "default" (on) when nobody decided yet. */
  source: "admin" | "default";
  canChange: boolean;
  updatedAt: string | null;
  /** What runs each AI feature, and where. */
  providers: { use: string; name: string; region: string }[];
}

async function trustRow(deps: Deps, orgId: string) {
  return deps.db.select().from(aiTrust).where(eq(aiTrust.orgId, orgId)).get();
}

async function rows(deps: Deps, orgId: string) {
  const [trust, key] = await Promise.all([
    deps.db.select().from(aiTrust).where(eq(aiTrust.orgId, orgId)).get(),
    deps.db.select({ provider: aiKeys.provider, problem: aiKeys.problem }).from(aiKeys).where(eq(aiKeys.orgId, orgId)).get(),
  ]);
  return { trust, key };
}

/** Whether AI may run in this workspace. Never throws on a read failure: a failed read counts as off when the controls are live. */
export async function aiAllowed(deps: Deps, orgId: string): Promise<boolean> {
  if (!featureOn(deps, "askTd1", orgId)) return true; // OPS1: per workspace flag
  try {
    const trust = await trustRow(deps, orgId);
    return trust ? !!trust.enabled : true;
  } catch {
    return false;
  }
}

/** Throws 409 ai_off before any provider call when AI is off. */
export async function assertAiAllowed(deps: Deps, orgId: string): Promise<void> {
  if (!(await aiAllowed(deps, orgId))) throw new HttpError(409, "ai_off", AI_OFF_MESSAGE);
}

export async function aiTrustState(deps: Deps, orgId: string, role: string): Promise<AiTrustState> {
  const { trust, key } = await rows(deps, orgId);
  const td1 = featureOn(deps, "askTd1", orgId); // OPS1: per workspace flags
  const ask = featureOn(deps, "askR110", orgId);
  const on = !td1 ? true : trust ? !!trust.enabled : true;
  const builtin = whereOf("builtin");
  const own = key ? whereOf(key.provider) : null;
  // QUAL1 (audit row 14): where the deployment lets built-in AI answer while the provider refuses the saved key
  // (AI_KEY_FALLBACK=on), this list says so before any refusal, and says when it is answering now. The same check
  // every AI path uses (keyFallbackOn), so the list never claims a stand-in that does not happen.
  const standIn = !!key && keyFallbackOn(deps)
    ? [{ use: key.problem ? "In their place now, while your key is refused" : "In their place if your provider refuses your key", ...builtin }]
    : [];
  const providers = own
    ? [...(ask ? [{ use: "Ask", ...builtin }] : []), { use: "Mail, meetings and Tools AI", ...own }, ...standIn]
    : [{ use: [ask ? "Ask" : null, "Tools AI", featureOn(deps, "aiConnectAi2", orgId) ? "mail" : null].filter(Boolean).join(", ").replace(/, ([^,]*)$/, " and $1"), ...builtin }];
  return {
    controls: td1, on, source: trust ? "admin" : "default",
    canChange: td1 && (role === "owner" || role === "admin"),
    updatedAt: trust ? new Date(trust.updatedAt).toISOString() : null, providers,
  };
}

export async function setAiTrust(deps: Deps, auth: { orgId: string; userId: string; email: string; role: string }, enabled: boolean): Promise<AiTrustState> {
  if (!featureOn(deps, "askTd1", auth.orgId)) throw new HttpError(404, "not_found", "Page not found.");
  if (auth.role !== "owner" && auth.role !== "admin") throw new HttpError(403, "forbidden", "Only an admin can turn AI on or off.");
  const values = { enabled, updatedBy: auth.userId || null, updatedAt: deps.now() };
  await deps.db.insert(aiTrust).values({ orgId: auth.orgId, ...values }).onConflictDoUpdate({ target: aiTrust.orgId, set: values });
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email, action: enabled ? "ai.turned_on" : "ai.turned_off", targetType: "workspace", targetId: auth.orgId });
  return aiTrustState(deps, auth.orgId, auth.role);
}
