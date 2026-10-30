/**
 * R62: registers the referral grant job. Kept tiny so the maintenance module that imports it for the side effect
 * loads nothing else at startup: the referral code itself loads when a job runs.
 */
import { registerJob } from "../jobs";

registerJob("billing.referral_grant", async (deps, payload) => {
  const { referralId } = (payload ?? {}) as { referralId?: string };
  if (!referralId) return;
  await (await import("./referrals")).grantReferral(deps, referralId);
});
