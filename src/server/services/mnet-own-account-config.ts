import { z } from "zod";
import { parseMnetObject } from "./mnet-json";

// Independent own-account display provenance, never an enrollment operator,
// membership mapping, grant or origin-derived identity default.
const principalAuthority = z.string().refine((s) => {
 if (!s.startsWith("https://") || new TextEncoder().encode(s).byteLength > 2048 || /[\s\p{Cc}\p{Cf}\p{Cs}\uFFFD?#\\]/u.test(s) || s.endsWith(":")) return false;
 try {
  const u = new URL(s);
  return /^https:\/\/[^/]+$/.test(s) && !s.slice(8).includes("@") && !!u.hostname && !u.username && !u.password && u.port !== "0";
 } catch { return false; }
});
export const ownAccountProvenanceSchema = z.object({
 version:z.literal(1), purpose:z.literal("mnet-own-account-summary"),
 principalAuthority, principalNamespace:z.literal("multies-local-user-v1"),
}).strict();
export type OwnAccountProvenance = z.infer<typeof ownAccountProvenanceSchema>;

export function ownAccountProvenanceConfig(raw: string | undefined, mode: string, bridge: boolean, consent: boolean, handoff: boolean): OwnAccountProvenance | undefined {
 if (raw === undefined) return undefined;
 if (mode !== "development" || !bridge || consent || handoff || raw.length === 0 || new TextEncoder().encode(raw).byteLength > 4096) throw new Error("Invalid Mnet summary-only provenance configuration");
 try { return ownAccountProvenanceSchema.parse(parseMnetObject(raw)); }
 catch { throw new Error("Invalid Mnet summary-only provenance configuration"); }
}
