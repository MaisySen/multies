import {it,expect} from "vitest";
import {readFileSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync,spawnSync} from "node:child_process";
import {enrollmentOperatorSchema} from "../src/server/services/mnet-enrollment-config";
import {serviceFixtureSchema} from "../src/server/services/mnet-enrollment-service-config";
const repo=process.env.MNET_NATIVE_REPO;
// The Go sample is the ONE shared vector, not an independently copied schema.
// Existing real Multies validators run before the Go consistency verifier.
(repo?it:it.skip)("disconnected plan shares actual Multies operator/service validators and refuses authority drift",()=>{
 const dir=mkdtempSync(join(tmpdir(),"mnet-plan-contract-"));
 try{
  const binary=join(dir,"verify");
  execFileSync("go",["build","-tags","mnet_enrollment_development","-o",binary,"./cmd/mnet-provisioning-development"],{cwd:repo,stdio:"pipe"});
  const sample=JSON.parse(readFileSync(join(repo!,"internal/enrollmentprovisioning/testdata/plan.json"),"utf8"));
  const operator=enrollmentOperatorSchema.parse(sample.multies_operator_snapshot);
  const scope=sample.multies_service_scope_snapshot;
  const service=serviceFixtureSchema.parse({reserveMs:1000,eventCapacity:3,serviceBudgets:{reserve:1,status:1,ack:1},requestsPerMinute:1,keys:[{...scope,active:true,digest:"A".repeat(42)+"E"}]});
  expect(operator.provenance?.version).toBe(2);expect(service.keys[0].serviceId).toBe(scope.serviceId);
  const verify=(p:unknown)=>spawnSync(binary,[],{input:JSON.stringify(p),encoding:"utf8"});
  const run=verify(sample);expect(run.status,run.stderr).toBe(0);
  const report=JSON.parse(run.stdout);expect(report).toMatchObject({configuration_consistent:true,authority_verified:false,deployable:false,workspace_count:2});
  const hash=report.plan_sha256;
  const spoofed=structuredClone(sample);spoofed.native_policy_snapshot.independent_trust_root_sha256="2".repeat(64);
  const untrusted=verify(spoofed);expect(untrusted.status).toBe(0);const untrustedReport=JSON.parse(untrusted.stdout);expect(untrustedReport.plan_sha256).not.toBe(hash);expect(untrustedReport.authority_verified).toBe(false);expect(untrustedReport.deployable).toBe(false);
  // Consistency cannot certify a bootstrap signature or independently obtained root.
  const signedClaim=structuredClone(sample);signedClaim.bootstrap_signature="not-a-trust-chain";expect(verify(signedClaim).status).toBe(1);
  const extraArg=spawnSync(binary,["--install"],{input:JSON.stringify(sample),encoding:"utf8"});expect(extraArg.status).toBe(2);
  const oversized=spawnSync(binary,[],{input:"x".repeat(256*1024+1),encoding:"utf8"});expect(oversized.status).toBe(1);
  expect(report.required_checks.every((c:{status:string})=>["unverified","unresolved"].includes(c.status))).toBe(true);
  const mutations:[string,(p:typeof sample)=>void][]=[
   ["valid but different audience",p=>{p.multies_service_scope_snapshot.audience="other-valid-audience";}],
   ["valid but rotated key",p=>{p.multies_service_scope_snapshot.keyId="key-rotated";}],
   ["valid but different principal",p=>{p.multies_operator_snapshot.bindings[0].principals=["different-person"];}],
   ["valid but changed revision",p=>{p.multies_operator_snapshot.revision="mapping-r2";}],
   ["valid but different origin",p=>{p.multies_service_scope_snapshot.registrarOrigin="https://other.example.test";}],
  ];
  for(const[name,mutate]of mutations){const p=structuredClone(sample);mutate(p);enrollmentOperatorSchema.parse(p.multies_operator_snapshot);serviceFixtureSchema.parse({...service,keys:[{...service.keys[0],...p.multies_service_scope_snapshot}]});expect(verify(p).status,name).toBe(1);}
  const unknown=structuredClone(sample);unknown.multies_operator_snapshot.secret="reject";expect(enrollmentOperatorSchema.safeParse(unknown.multies_operator_snapshot).success).toBe(false);expect(verify(unknown).status).toBe(1);
 }finally{rmSync(dir,{recursive:true,force:true});}
},30000);
