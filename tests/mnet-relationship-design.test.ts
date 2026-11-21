import {describe, expect, it} from "vitest";
import {readFileSync, readdirSync, statSync} from "node:fs";
import {join} from "node:path";
import {evaluateRelationship, relationshipEvent, type RelationshipFacts, type EventFacts, type RelationshipEvent} from "../experiments/mnet-relationship-design/model";
function facts(): RelationshipFacts {return {subjectUserId:"user-1",approvingUserId:"user-1",approval:{explicitOngoingNetworking:true,authenticated:true,impersonated:false,loginMethod:"google",generation:"approval-1",securityGeneration:"security-1"},current:{factsAvailable:true,userEligible:true,humanMembershipEnabled:true,workspaceEligible:true,role:"member",requireSso:false,securityEventsEvaluated:true,securityGeneration:"security-1",approvalGeneration:"approval-1",approvalWithdrawn:false}};}
function event(event: RelationshipEvent): EventFacts {return {event,subjectUserId:"user-1",actorUserId:"user-1",actorAuthenticated:true,actorImpersonated:false,sourceEventVerified:true,approvalLoginMethod:"google",currentRole:"member"};}

describe("isolated pure networking relationship design DATA, not authority",()=>{
 it("positive result is frozen data only, leaves input unchanged and supplies no access material",()=>{
  const f=facts(),before=JSON.stringify(f);const r=evaluateRelationship(f);
  expect(r).toEqual({kind:"relationship-eligibility-design-data",reason:"eligible-data",eligibleForFurtherEvaluation:true,derivedSuspended:false,authorityGranted:false});
  expect(Object.keys(r).sort()).toEqual(["kind","reason","eligibleForFurtherEvaluation","derivedSuspended","authorityGranted"].sort());expect(Object.isFrozen(r)).toBe(true);expect(JSON.stringify(f)).toBe(before);expect(evaluateRelationship(f)).toEqual(r);
 });
 it.each(["explicitOngoingNetworking","authenticated"] as const)("approval requires %s",key=>{const f=facts();expect(evaluateRelationship({...f,approval:{...f.approval,[key]:false}}).reason).toBe("approval-refused");});
 it("impersonated approval cannot create standing eligibility even for owner/admin",()=>{for(const role of ["owner","admin","member"] as const){const f=facts();expect(evaluateRelationship({...f,approval:{...f.approval,impersonated:true},current:{...f.current,role}}).reason).toBe("approval-refused");}});
 it("refuses cross-user approval and unavailable/untyped facts",()=>{
  const f=facts();expect(evaluateRelationship({...f,approvingUserId:"operator"}).reason).toBe("approval-refused");
  expect(evaluateRelationship({...f,current:{...f.current,factsAvailable:false}}).reason).toBe("facts-unavailable");
  for(const bad of [null,{}, {...f,current:{...f.current,requireSso:"false"}}, {...f,approval:{...f.approval,generation:""}}])expect(evaluateRelationship(bad as RelationshipFacts).reason).toBe("invalid-facts");
 });
 it.each(["userEligible","humanMembershipEnabled","workspaceEligible"] as const)("derived suspension when %s false is not stored or approval",key=>{const f=facts();const r=evaluateRelationship({...f,current:{...f.current,[key]:false}});expect(r.reason).toBe("eligibility-unmet");expect(r.derivedSuspended).toBe(true);expect(r.authorityGranted).toBe(false);});
 it("requires explicit security fact evaluation and exact approval/security generations",()=>{
  const f=facts();for(const change of [{securityEventsEvaluated:false},{securityGeneration:"security-2"}])expect(evaluateRelationship({...f,current:{...f.current,...change}}).reason).toBe("security-reapproval-required");
  expect(evaluateRelationship({...f,current:{...f.current,approvalGeneration:"approval-2"}}).reason).toBe("approval-withdrawn");
 });
 it("eligibility restoration cannot undo withdrawn approval or a security generation change",()=>{
  const f=facts();const withdrawn={...f,current:{...f.current,approvalWithdrawn:true}};
  expect(evaluateRelationship({...withdrawn,current:{...withdrawn.current,userEligible:false}}).eligibleForFurtherEvaluation).toBe(false);
  expect(evaluateRelationship(withdrawn).reason).toBe("approval-withdrawn");
  const secured={...f,current:{...f.current,securityGeneration:"security-2"}};expect(evaluateRelationship(secured).eligibleForFurtherEvaluation).toBe(false);
  const proposedNewApproval={...secured,approval:{...f.approval,generation:"approval-2",securityGeneration:"security-2"},current:{...secured.current,approvalGeneration:"approval-2"}};
  expect(evaluateRelationship(proposedNewApproval).reason).toBe("eligible-data"); // Supplied facts, not generated or authenticated here.
 });
 it.each(["owner","admin","member"] as const)("SSO applies current %s role to approval-time login method",role=>{
  for(const loginMethod of ["email","auth0","google"] as const){const f=facts();const r=evaluateRelationship({...f,approval:{...f.approval,loginMethod},current:{...f.current,role,requireSso:true}});expect(r.eligibleForFurtherEvaluation).toBe(role==="owner"||loginMethod!=="email");}
 });
 it("SSO toggle back cannot resurrect approval withdrawn by the verified event",()=>{const e=relationshipEvent({...event("sso-required"),approvalLoginMethod:"email"});expect(e.requiresNewApprovalGeneration).toBe(true);const f=facts();expect(evaluateRelationship({...f,current:{...f.current,requireSso:false,approvalWithdrawn:true}}).reason).toBe("approval-withdrawn");});
 it.each(["password-change","password-reset","session-compromise","credential-compromise","security-revoke"] as const)("%s is an explicit required security withdrawal fact, not an existing hook",kind=>{
  const r=relationshipEvent(event(kind));expect(r.requirement).toBe("withdraw-approval-and-request-stop");expect(r.requiresSecurityGenerationChange).toBe(true);expect(r.requiresNewApprovalGeneration).toBe(true);expect(r.authorityGranted).toBe(false);
  expect(relationshipEvent({...event(kind),sourceEventVerified:false}).requirement).toBe("refuse");
 });
 it.each(["membership-removed","user-banned","workspace-suspended","workspace-deleted"] as const)("%s requires withdrawn approval, no automatic restore",kind=>{expect(relationshipEvent(event(kind)).requiresNewApprovalGeneration).toBe(true);expect(relationshipEvent(event("eligibility-restored")).requirement).toBe("recheck-only-no-reapproval");});
 it("own-user revoke does not require workspace eligibility and never grants cross-user admin power",()=>{
  expect(relationshipEvent(event("own-device-revoke")).requirement).toBe("withdraw-approval-and-request-stop");
  for(const role of ["owner","admin","member"] as const){expect(relationshipEvent({...event("own-device-revoke"),actorUserId:"someone-else",currentRole:role}).requirement).toBe("refuse");}
  expect(relationshipEvent({...event("own-device-revoke"),actorImpersonated:true}).requirement).toBe("refuse");expect(relationshipEvent({...event("own-device-revoke"),actorAuthenticated:false}).requirement).toBe("refuse");
 });
 it("distinguishes proposed browser logout, local controls and source outage without side effects",()=>{
  const rows:[[RelationshipEvent,ReturnType<typeof relationshipEvent>["requirement"]],...Array<[RelationshipEvent,ReturnType<typeof relationshipEvent>["requirement"]]>]=[["browser-sign-out","no-change"],["local-disconnect","local-stop-only"],["disable-startup","local-preference-only"],["companion-sign-out","withdraw-approval-and-request-stop"],["source-unavailable","deny-new-evaluation-without-revocation"]];
  for(const [kind,want]of rows){const f=event(kind),before=JSON.stringify(f),r=relationshipEvent(f);expect(r.requirement).toBe(want);expect(r.authorityGranted).toBe(false);expect(Object.isFrozen(r)).toBe(true);expect(JSON.stringify(f)).toBe(before);expect(Object.keys(r).sort()).toEqual(["kind","recognizedWithinModel","requirement","requiresNewApprovalGeneration","requiresSecurityGenerationChange","authorityGranted"].sort());}
  expect(relationshipEvent({...event("browser-sign-out"),event:"unknown" as RelationshipEvent}).requirement).toBe("refuse");
 });
 it("has no imports, I/O, clock, storage, grant output or production importer",()=>{
  const source=readFileSync(new URL("../experiments/mnet-relationship-design/model.ts",import.meta.url),"utf8");expect(source).not.toMatch(/^import\s/m);expect(source).not.toMatch(/\b(?:fetch|Date|setTimeout|setInterval|process|localStorage|crypto)\b/);
  const walk=(dir:string)=>{for(const name of readdirSync(dir)){const p=join(dir,name);if(statSync(p).isDirectory())walk(p);else if(/\.[cm]?[jt]sx?$/.test(name)){const raw=readFileSync(p,"utf8");expect(raw,p).not.toMatch(/mnet-relationship-design|\bevaluateRelationship\b|\brelationshipEvent\b/);}}};walk(new URL("../src",import.meta.url).pathname);
 });
});
