import type { AppConfig } from "../config";
import type { Deps } from "../context";
import { idpIssuer } from "./config";
import { firstOperatorIdentity, type FirstOperatorIdentity } from "./first-operator-identity";

import type { PendingGrantRecovery } from "./first-operator-ledger";

type Command = Readonly<{ mode: "grant" | "revoke"; identity: FirstOperatorIdentity }>;
type FreshRecovery = Readonly<{ identity: FirstOperatorIdentity; pending: PendingGrantRecovery }>;

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
  let run=ownerRuns.get(deps);
  if (!run) {
    run=(async()=>{
      try {
        const [{authFor},{applyFirstOperatorRecovery}]=await Promise.all([import("./options"),import("./first-operator-transition")]);
        const {internalAdapter}=await authFor(deps).$context;
        const outcome=await applyFirstOperatorRecovery(deps,identity,internalAdapter,fresh?.pending);
        deps.log?.info("operator.first_recovery",{outcome});
      } catch { deps.log?.warn("operator.first_recovery_unconfirmed"); }
    })();
    ownerRuns.set(deps,run);
  }
  await run;
}
