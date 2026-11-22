import { describe, expect, it } from "vitest";
import { loadConfig } from "@/server/config";

const provenance = {version:1,purpose:"mnet-own-account-summary",principalAuthority:"https://identity.example.invalid",principalNamespace:"multies-local-user-v1"};
const base = {APP_SECRET:"t".repeat(40),MNET_DEVICE_BRIDGE:"on",MNET_ENROLLMENT_CONSENT:"off",MNET_ENROLLMENT_HANDOFF:"off"};
const configured = {...base,MNET_OWN_ACCOUNT_PROVENANCE:JSON.stringify(provenance)};

describe("summary-only provenance through actual loadConfig", () => {
 it("is strictly absent by default and never derives identity from app or bridge origin", () => {
  for (const raw of [{APP_SECRET:base.APP_SECRET},{...base,APP_URL:"https://transport.example.invalid"},{...base,MNET_ENROLLMENT_OPERATOR:JSON.stringify({provenance})}]) {
   const c=loadConfig(raw);expect(c.mnetOwnAccountProvenance).toBeUndefined();
   expect(c.mnetEnrollmentConsent).toBe(false);expect(c.mnetEnrollmentHandoff).toBe(false);expect(c.mnetEnrollmentService).toBe(false);expect(c.mnetEnrollmentOperator).toBeUndefined();
  }
 });
 it("loads only the explicit independent provenance with all enrollment defaults unchanged", () => {
  const c=loadConfig({...configured,APP_URL:"https://different-transport.example.invalid"});
  expect(c.mnetOwnAccountProvenance).toEqual(provenance);expect(c.mnetDeviceBridge).toBe(true);
  expect(c.mnetEnrollmentConsent).toBe(false);expect(c.mnetEnrollmentHandoff).toBe(false);expect(c.mnetEnrollmentOperator).toBeUndefined();
  expect(c.mnetEnrollmentService).toBe(false);expect(c.mnetEnrollmentServiceFixture).toBeUndefined();expect(c.mnetEnrollmentHandoffFixture).toBeUndefined();
 });
 it("rejects malformed, ambiguous and enrollment-shaped input before route construction", () => {
  const good=JSON.stringify(provenance);
  const invalid=["", "null", "[]", "{}",good+" {}",good.replace('"version":1','"version":2'),good.replace('"version":1','"Version":1'),'{"version":1,'+good.slice(1),'{"vers\\u0069on":1,'+good.slice(1),JSON.stringify({...provenance,extra:false}),JSON.stringify({...provenance,principalNamespace:"oidc-subject"}),JSON.stringify({...provenance,principalAuthority:"http://localhost"}),JSON.stringify({...provenance,principalAuthority:"https://identity.example.invalid/"}),JSON.stringify({...provenance,principalAuthority:"https://user@identity.example.invalid"}),JSON.stringify({...provenance,principalAuthority:"https://identity.example.invalid?"}),JSON.stringify({...provenance,purpose:"enroll"}),JSON.stringify({provenance})," ".repeat(4097)+good];
  for (const text of invalid) {
   let constructed=false;
   expect(()=>{loadConfig({...base,MNET_OWN_ACCOUNT_PROVENANCE:text});constructed=true;}).toThrow("summary-only provenance");
   expect(constructed).toBe(false);
  }
 });
 it("refuses enabling summary provenance outside development bridge-only mode", () => {
  for (const patch of [{APP_MODE:"production"},{MNET_DEVICE_BRIDGE:"off"},{MNET_ENROLLMENT_CONSENT:"on"},{MNET_ENROLLMENT_HANDOFF:"on"}]) expect(()=>loadConfig({...configured,...patch})).toThrow();
 });
});
