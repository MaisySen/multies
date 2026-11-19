import type { AppConfig } from "../config";
import type { Deps } from "../context";
import { idpIssuer } from "./config";
import { firstOperatorIdentity, type FirstOperatorIdentity } from "./first-operator-identity";

import type { FreshGrantRevocation } from "./first-operator-ledger";

type Command = Readonly<{ mode: "grant" | "revoke"; identity: FirstOperatorIdentity }>;
type FreshRecovery = Readonly<{ identity: FirstOperatorIdentity; pending: FreshGrantRevocation }>;

/** Stage only. The normal grant parser never interprets this as authority to grant access. */
function readPendingRecovery(config: AppConfig, now: number, origin: string, protectedOrigin?: string): FreshRecovery | null {
  const raw = config.firstOperatorCommand;
  const idp = config.auth.auth0;
  const configured = config.appUrl.replace(/\/$/, "");
  if (!protectedOrigin || protectedOrigin !== configured || origin !== configured || !idp ||
      typeof raw !== "string" || raw.length > 6000 || config.platformAdmins.length ||
      !/^[a-f0-9]{12,64}$/.test(config.release)) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(v) || v.length !== 4 || v[0] !== "revoke-pending" || v[1] !== config.release ||
      !Array.isArray(v[2]) || typeof v[3] !== "string" ||
      !/^release-owner:first-operator:[a-f0-9]{64}$/.test(v[3])) return null;
  const identity = firstOperatorIdentity(JSON.stringify(v[2]), {
    origin: configured, issuer: idpIssuer(idp.domain), audience: idp.clientId, legacyBootstrapConfigured: false,
  }, now);
  if (!identity || identity.expiresAt - identity.startsAt > 5 * 60_000) return null;
  return Object.freeze({ identity, pending: Object.freeze({ priorOwner: v[3] }) });
}

/** Deployment owner binding only. An HTTP request cannot select mode, identity, timing or release. */
export function readFirstOperatorCommand(config: AppConfig, now: number): Command | null {
  const raw = config.firstOperatorCommand;
  const idp = config.auth.auth0;
  if (!idp || typeof raw !== "string" || raw.length > 6000 || config.platformAdmins.length || !/^[0-9a-f]{12,64}$/.test(config.release)) return null;
  let v: unknown;
  try { v=JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(v) || v.length !== 3 || (v[0] !== "grant" && v[0] !== "revoke") || v[1] !== config.release || !Array.isArray(v[2])) return null;
  const identity=firstOperatorIdentity(JSON.stringify(v[2]),{origin:config.appUrl.replace(/\/$/,""),issuer:idpIssuer(idp.domain),audience:idp.clientId,legacyBootstrapConfigured:false},now);
  return identity ? Object.freeze({mode:v[0], identity}) : null;
}

const ownerRuns = new WeakMap<Deps, Promise<void>>();
/** No endpoint or scheduler: a normal request to the exact origin serializes with the private owner operation. */
export async function completeFirstOperatorRecovery(deps: Deps, origin: string, privateStageProbeOrigin?: string): Promise<void> {
  const now = deps.now().getTime();
  const cmd = readFirstOperatorCommand(deps.config, now);
  const fresh = readPendingRecovery(deps.config, now, origin, privateStageProbeOrigin);
  const identity = fresh?.identity ?? (cmd?.mode === "revoke" ? cmd.identity : undefined);
  if (!identity || identity.origin !== origin) return;
  await runOwnerRecovery(deps, identity, fresh?.pending);
}

async function runOwnerRecovery(deps: Deps, identity: FirstOperatorIdentity, recovery?: FreshGrantRevocation): Promise<void> {
  let run=ownerRuns.get(deps);
  if (!run) {
    run=(async()=>{
      try {
        const [{authFor},{applyFirstOperatorRecovery}]=await Promise.all([import("./options"),import("./first-operator-transition")]);
        const {internalAdapter}=await authFor(deps).$context;
        const outcome=await applyFirstOperatorRecovery(deps,identity,internalAdapter,recovery);
        deps.log?.info("operator.first_recovery",{outcome});
      } catch { deps.log?.warn("operator.first_recovery_unconfirmed"); }
    })();
    ownerRuns.set(deps,run);
  }
  await run;
}

const OWNER_RECOVERY_ORIGIN = "https://multies.si";
const OWNER_RECOVERY_CRON = "*/15 * * * *";
const OWNER_RECOVERY_SLOT_MS = 15 * 60_000;
const OWNER_RECOVERY_MAX_WINDOW_MS = 5 * 60_000;

/** Only the provider's existing maintenance event calls this path. No HTTP or app-user input. */
export async function completeScheduledOwnerRevocation(deps: Deps, event: unknown, productionBindingPresent: boolean): Promise<void> {
  const c = deps.config, raw = c.firstOperatorCommand, idp = c.auth.auth0, now = deps.now().getTime();
  if (productionBindingPresent !== true || c.mode !== "production" || c.appUrl.replace(/\/$/, "") !== OWNER_RECOVERY_ORIGIN ||
      !idp || c.platformAdmins.length || !/^[a-f0-9]{12,64}$/.test(c.release) ||
      typeof raw !== "string" || raw.length > 6000 || !event || typeof event !== "object") return;
  const tick = event as { cron?: unknown; scheduledTime?: unknown };
  if (tick.cron !== OWNER_RECOVERY_CRON || typeof tick.scheduledTime !== "number" || !Number.isSafeInteger(tick.scheduledTime) ||
      tick.scheduledTime % OWNER_RECOVERY_SLOT_MS !== 0 || tick.scheduledTime > now) return;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return; }
  if (!Array.isArray(v) || !((v.length === 6 && v[0] === "revoke-at-owner-maintenance") ||
      (v.length === 8 && v[0] === "resume-owner-revocation")) || v[1] !== c.release ||
      !Array.isArray(v[2]) || typeof v[3] !== "string" || !/^release-owner:first-operator:[a-f0-9]{64}$/.test(v[3]) ||
      (v[4] !== "pending" && v[4] !== "applied") || v[5] !== tick.scheduledTime) return;
  const identity = firstOperatorIdentity(JSON.stringify(v[2]), {
    origin: OWNER_RECOVERY_ORIGIN, issuer: idpIssuer(idp.domain), audience: idp.clientId, legacyBootstrapConfigured: false,
  }, now);
  if (!identity || identity.expiresAt - identity.startsAt > OWNER_RECOVERY_MAX_WINDOW_MS ||
      tick.scheduledTime < identity.startsAt || tick.scheduledTime >= identity.expiresAt) return;
  let resume: FreshGrantRevocation["resume"];
  if (v[0] === "resume-owner-revocation") {
    if (typeof v[6] !== "string" || !/^release-owner:first-operator:[a-f0-9]{64}$/.test(v[6]) ||
        typeof v[7] !== "number" || !Number.isSafeInteger(v[7]) || v[7] <= 0 || v[7] >= identity.startsAt) return;
    resume={cutoffOwner:v[6],cutoffAtMs:v[7]};
  }
  await runOwnerRecovery(deps, identity, { priorOwner: v[3], expectedGrantOutcome: v[4], resume });
}
