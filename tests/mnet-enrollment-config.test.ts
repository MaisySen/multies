import { describe, it, expect } from "vitest";
import { enrollmentOperatorConfig } from "@/server/services/mnet-enrollment-config";
import { loadConfig } from "@/server/config";
const fixture = { revision: "r1", issuer: "https://issuer.test/path", registrarOrigin: "https://registrar.test", audience: "enrollment", bindings: [{ workspaceId: "fixture", networkId: "net-fixture", principals: ["subject"] }] };
describe("explicit enrollment operator input", () => {
 it("has no default and is ignored while disabled", () => {
  expect(enrollmentOperatorConfig()).toBeUndefined();
  expect(loadConfig({ APP_SECRET: "t".repeat(40), MNET_ENROLLMENT_OPERATOR: "bad" }).mnetEnrollmentOperator).toBeUndefined();
  expect(() => loadConfig({ APP_SECRET: "t".repeat(40), MNET_ENROLLMENT_CONSENT: "on", MNET_ENROLLMENT_OPERATOR: "bad" })).toThrow();
 });
 it("preserves exact issuer paths and explicit default ports without normalization", () => {
  const c = { ...fixture, issuer: "https://issuer.test:443/path", registrarOrigin: "https://registrar.test:443" };
  expect(enrollmentOperatorConfig(JSON.stringify(c))).toEqual(c);
 });
 it("rejects duplicates, unknown policy, empty members and unsafe endpoints", () => {
  for (const c of [ { ...fixture, bindings: [...fixture.bindings, ...fixture.bindings] }, { ...fixture, policy: "everyone" }, { ...fixture, bindings: [{ ...fixture.bindings[0], principals: [] }] }, ...["http://registrar.test", "https://user:pw@registrar.test", "https://registrar.test/path", "https://registrar.test?", "https://registrar.test#", "https://registrar.test:", "https://registrar.test:0"].map((registrarOrigin) => ({ ...fixture, registrarOrigin })) ]) expect(() => enrollmentOperatorConfig(JSON.stringify(c))).toThrow();
  const raw = JSON.stringify(fixture).replace('"revision":"r1"', '"revision":"r1","revision":"r2"'); expect(() => enrollmentOperatorConfig(raw)).toThrow();
 });
});

it("refuses consent preview in production even with valid operator config",()=>{expect(()=>loadConfig({APP_SECRET:"t".repeat(40),APP_MODE:"production",MNET_ENROLLMENT_CONSENT:"on",MNET_ENROLLMENT_OPERATOR:JSON.stringify(fixture)})).toThrow();});
