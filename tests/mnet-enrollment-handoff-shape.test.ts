import { describe, expect, it } from "vitest";
import { enrollmentHandoffCore, enrollmentCodeProofCore } from "@/server/services/mnet-enrollment-handoff-shape";
import { parseMnetObject } from "@/server/services/mnet-json";
import { mnetLaunch } from "@/server/services/mnet";
import { enrollmentLaunch } from "@/server/services/mnet-enrollment";
const digest = btoa(String.fromCharCode(...new Uint8Array(32).fill(9))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fixture = { version: 1, purpose: "mnet-enrollment", attemptId: digest, devicePublicKey: digest, challenge: digest, state: digest, redirectUri: "http://127.0.0.1:32145/mnet/enrollment/callback", platform: "linux" };
describe("provisional enrollment-only handoff core parsing, no route", () => {
 it("accepts only the exact new version/purpose, not List or existing preview", () => {
  expect(enrollmentHandoffCore.parse(fixture)).toEqual(fixture);
  expect(mnetLaunch.safeParse(fixture).success).toBe(false);
  expect(enrollmentLaunch.safeParse(fixture).success).toBe(false);
  for (const change of [{ version: 0 }, { version: "1" }, { purpose: "list" }, { purpose: "mnet" }, { capabilities: ["enroll"] }, { inputAuthorized: true }, { issuer: "https://browser-chosen.test" }, { networkId: "browser-network" }, { registrarOrigin: "https://browser-chosen.test" }]) expect(enrollmentHandoffCore.safeParse({ ...fixture, ...change }).success).toBe(false);
  for (const key of Object.keys(fixture)) { const omitted: Record<string, unknown> = { ...fixture }; delete omitted[key]; expect(enrollmentHandoffCore.safeParse(omitted).success).toBe(false); }
 });
 it("rejects callback scheme/host/path aliases and bounds port exactly", () => {
  for (const redirectUri of ["https://127.0.0.1:32145/mnet/enrollment/callback", "http://localhost:32145/mnet/enrollment/callback", "http://2130706433:32145/mnet/enrollment/callback", "http://127.0.0.1:32145/mnet/callback", "http://127.0.0.1:32145/mnet/enrollment/callback?state=chosen", "http://127.0.0.1:32145/mnet/enrollment/callback#", "http://user@127.0.0.1:32145/mnet/enrollment/callback", "http://127.0.0.1:1023/mnet/enrollment/callback", "http://127.0.0.1:65536/mnet/enrollment/callback", "http://127.0.0.1:032145/mnet/enrollment/callback"]) expect(enrollmentHandoffCore.safeParse({ ...fixture, redirectUri }).success).toBe(false);
  for (const port of [1024, 65535]) expect(enrollmentHandoffCore.safeParse({ ...fixture, redirectUri: `http://127.0.0.1:${port}/mnet/enrollment/callback` }).success).toBe(true);
 });
 it("requires canonical nonzero32byte public digests and exact native proof shape", () => {
  for (const key of ["attemptId", "devicePublicKey", "challenge", "state"]) for (const value of [null, "", "A".repeat(43), digest + "=", digest.slice(0, -1) + "B", digest + "\n"]) expect(enrollmentHandoffCore.safeParse({ ...fixture, [key]: value }).success).toBe(false);
  const proof = { ...fixture, code: digest, verifier: "v".repeat(64) }; expect(enrollmentCodeProofCore.parse(proof)).toEqual(proof);
  for (const verifier of ["v".repeat(42), "v".repeat(129), "contains spaces".repeat(4), "bad\n".repeat(20)]) expect(enrollmentCodeProofCore.safeParse({ ...proof, verifier }).success).toBe(false);
 });
 it("shared strict JSON rejects decoded duplicate fields before the shape parser", () => {
  for (const raw of [JSON.stringify(fixture).replace('"version":1', '"version":1,"version":2'), JSON.stringify(fixture).replace('"state":', '"st\\u0061te":"changed","state":')]) expect(() => enrollmentHandoffCore.parse(parseMnetObject(raw))).toThrow();
 });
});
