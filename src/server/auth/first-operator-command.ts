import type { AppConfig } from "../config";
import type { Deps } from "../context";
import { idpIssuer } from "./config";
import { firstOperatorIdentity, type FirstOperatorIdentity } from "./first-operator-identity";

type Command = Readonly<{ mode: "grant" | "revoke"; identity: FirstOperatorIdentity }>;

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
export async function completeFirstOperatorRecovery(deps: Deps, origin: string): Promise<void> {
  const cmd=readFirstOperatorCommand(deps.config,deps.now().getTime());
  if (!cmd || cmd.mode!=="revoke" || cmd.identity.origin!==origin) return;
  let run=ownerRuns.get(deps);
  if (!run) {
    run=(async()=>{
      try {
        const [{authFor},{applyFirstOperatorRecovery}]=await Promise.all([import("./options"),import("./first-operator-transition")]);
        const {internalAdapter}=await authFor(deps).$context;
        const outcome=await applyFirstOperatorRecovery(deps,cmd.identity,internalAdapter);
        deps.log?.info("operator.first_recovery",{outcome});
      } catch { deps.log?.warn("operator.first_recovery_unconfirmed"); }
    })();
    ownerRuns.set(deps,run);
  }
  await run;
}
