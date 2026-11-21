import { z } from "zod";

// Shared enrollment-only parser. Routed handoff uses the core. This does
// not choose journal, credential issuance/recovery, expiry or activation policy.
const digest = z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine((s) => {
 try {
  const bytes = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=");
  return bytes.length === 32 && [...bytes].some((c) => c.charCodeAt(0) !== 0) && btoa(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") === s;
 } catch { return false; }
});
const callback = z.string().max(140).refine((s) => {
 // A distinct fixed path isolates this future handoff from the current List
 // callback. No caller-chosen URL, localhost DNS or numeric-host aliases.
 if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}\/mnet\/enrollment\/callback$/.test(s)) return false;
 try { const u = new URL(s); return +u.port >= 1024 && +u.port <= 65535 && u.href === s; } catch { return false; }
});
export const enrollmentHandoffCore = z.object({
 version: z.literal(1), purpose: z.literal("mnet-enrollment"),
 attemptId: digest, devicePublicKey: digest, challenge: digest, state: digest,
 redirectUri: callback, platform: z.enum(["linux", "macos", "windows"]),
}).strict();
export const enrollmentCodeProofCore = enrollmentHandoffCore.extend({
 code: digest, verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
}).strict();
