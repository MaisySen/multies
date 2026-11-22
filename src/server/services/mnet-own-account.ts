import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import type { Deps } from "../context";
import { mnetDevices, organizations, sessions, users } from "../db/schema";
import { HttpError } from "../lib/errors";
import { enrollmentOperatorSchema } from "./mnet-enrollment-config";
import { hash, liveEligibility, mnetLaunch } from "./mnet";

// Separate own-account display DATA. This is not a joining grant, source ticket,
// key-possession proof, native confirmation or permission to persist a pin.
const label = (max: number, empty = false) => z.string().min(empty ? 0 : 1).max(max)
  .refine((s) => s.trim() === s && !/[\p{Cc}\p{Cf}\p{Cs}\uFFFD]/u.test(s));
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const epochMS = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
// Explicit wire grammar shared with the native decoder.
const accountEmail = /^([A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
export const mnetOwnAccountSummarySchema = z.object({
  version: z.literal(1), purpose: z.literal("mnet-own-account-identity"), audience: z.literal("mnet"),
  principalAuthority: enrollmentOperatorSchema.shape.provenance.unwrap().shape.principalAuthority,
  principalNamespace: z.literal("multies-local-user-v1"), principalId: id,
  workspaceId: id, workspaceName: label(256), email: label(320).regex(accountEmail),
  accountName: label(256, true), deviceKey: mnetLaunch.shape.deviceKey, verifiedEmail: z.literal(true),
  checkedAtMS: epochMS, expiresAtMS: epochMS, capabilities: z.tuple([z.literal("list")]),
  enrollmentAuthorized: z.literal(false), networkAuthorized: z.literal(false), inputAuthorized: z.literal(false),
}).strict().refine((s) => s.expiresAtMS > s.checkedAtMS && s.expiresAtMS - s.checkedAtMS <= 30_000);
export type MnetOwnAccountSummary = z.infer<typeof mnetOwnAccountSummarySchema>;

// No new production flag/default. Missing explicit source provenance keeps this
// branch-only operation unavailable; existing List endpoints are unchanged.
export function ownAccountSummaryConfig(d: Deps) {
  const parsed = enrollmentOperatorSchema.safeParse(d.config.mnetEnrollmentOperator);
  if (d.config.mode !== "development" || !d.config.mnetDeviceBridge || !parsed.success || !parsed.data.provenance) {
    throw new HttpError(404, "not_found", "Not found.");
  }
  return parsed.data.provenance;
}
const denied = () => new HttpError(403, "mnet_denied", "Mnet access is unavailable.");

export async function ownAccountSummary(d: Deps, credential: string): Promise<MnetOwnAccountSummary> {
  const provenance = ownAccountSummaryConfig(d);
  if (!mnetLaunch.shape.deviceKey.safeParse(credential).success) throw denied();
  const checkedAt = d.now();
  // The credential owner, labels and live eligibility are read together. No
  // requested person/workspace/device selector and no uncorrelated label read.
  const row = await d.db.select({
    principalId: mnetDevices.userId, workspaceId: mnetDevices.workspaceId,
    workspaceName: organizations.name, email: users.email, accountName: users.name,
    deviceKey: mnetDevices.deviceKey, credentialExpiresAt: mnetDevices.credentialExpiresAt,
    sessionExpiresAt: sessions.expiresAt,
  }).from(mnetDevices)
    .innerJoin(users, eq(users.id, mnetDevices.userId))
    .innerJoin(organizations, eq(organizations.id, mnetDevices.workspaceId))
    .innerJoin(sessions, and(eq(sessions.id, mnetDevices.sessionId), eq(sessions.userId, mnetDevices.userId)))
    .where(and(eq(mnetDevices.credentialHash, await hash(credential)), eq(mnetDevices.status, "active"),
      gt(mnetDevices.credentialExpiresAt, d.now()),
      liveEligibility(d, mnetDevices.userId, mnetDevices.workspaceId, mnetDevices.sessionId))).get();
  if (!row || !row.credentialExpiresAt) throw denied();
  const summary = mnetOwnAccountSummarySchema.safeParse({
    version: 1, purpose: "mnet-own-account-identity", audience: "mnet",
    principalAuthority: provenance.principalAuthority, principalNamespace: provenance.principalNamespace,
    principalId: row.principalId, workspaceId: row.workspaceId, workspaceName: row.workspaceName,
    email: row.email, accountName: row.accountName, deviceKey: row.deviceKey, verifiedEmail: true,
    checkedAtMS: checkedAt.getTime(),
    expiresAtMS: Math.min(checkedAt.getTime() + 30_000, row.credentialExpiresAt.getTime(), row.sessionExpiresAt.getTime()),
    capabilities: ["list"], enrollmentAuthorized: false, networkAuthorized: false, inputAuthorized: false,
  });
  if (!summary.success || summary.data.expiresAtMS <= d.now().getTime()) throw denied();
  const current = ownAccountSummaryConfig(d);
  if (current.principalAuthority !== provenance.principalAuthority || current.principalNamespace !== provenance.principalNamespace) throw denied();
  return summary.data;
}
