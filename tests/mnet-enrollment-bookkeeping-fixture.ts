import { expect } from "vitest";
import { randomToken } from "@/server/lib/crypto";
import { hash } from "@/server/services/mnet";
import { makeTestApp,Client } from "./helpers";
import { eq } from "drizzle-orm";
import { users,members } from "@/server/db/schema";
const handoffPolicy={consentMs:600000,codeMs:60000,ticketMs:120000,fullRowRetentionMs:1000,capacity:10,maxRows:100,retention:"terminal-hash-tombstone"};
const path="/api/mnet-enrollment-service-v1/reserve";
export async function setupBookkeeping(){
 const secret=randomToken();
 const fixture={reserveMs:30000,eventCapacity:3,serviceBudgets:{reserve:100,status:100,ack:100},requestsPerMinute:100,keys:[{keyId:"fixture-key",serviceId:"fixture-registrar",active:true,digest:await hash(secret),registrarOrigin:"https://registrar.test",issuer:"https://issuer.test/path",audience:"fixture-enrollment"}]};
 const e=await makeTestApp({MNET_ENROLLMENT_HANDOFF:"on",MNET_ENROLLMENT_HANDOFF_FIXTURE:JSON.stringify(handoffPolicy),MNET_ENROLLMENT_SERVICE:"on",MNET_ENROLLMENT_SERVICE_FIXTURE:JSON.stringify(fixture)});
 const person=new Client(e.app);await person.signup();const user=await e.db.select().from(users).where(eq(users.email,person.email!)).get();await e.db.update(users).set({emailVerified:true}).where(eq(users.id,user!.id));const member=await e.db.select().from(members).where(eq(members.userId,user!.id)).get();
 e.deps.config.mnetEnrollmentOperator={revision:"fixture-r1",issuer:fixture.keys[0].issuer,registrarOrigin:fixture.keys[0].registrarOrigin,audience:fixture.keys[0].audience,bindings:[{workspaceId:member!.organizationId,networkId:"fixture-net",principals:[user!.id]}]};
 const verifier=randomToken(),launch={version:1,purpose:"mnet-enrollment",attemptId:randomToken(),devicePublicKey:randomToken(),credentialDigest:randomToken(),challenge:await hash(verifier),state:randomToken(),platform:"linux",redirectUri:"http://127.0.0.1:34567/mnet/enrollment/callback"};
 const displayed={issuer:fixture.keys[0].issuer,registrarOrigin:fixture.keys[0].registrarOrigin,audience:fixture.keys[0].audience,mappingRevision:"fixture-r1",networkId:"fixture-net"};
 const prepared=await person.post("/api/mnet-enrollment-v1/authorizations",{...launch,workspaceId:member!.organizationId,displayed});expect(prepared.status).toBe(201);
 const choice=await person.post(`/api/mnet-enrollment-v1/authorizations/${prepared.body.id}/decision`,{decision:"allow"});expect(choice.status).toBe(200);
 const response=await e.app.request("/api/mnet-enrollment-v1/exchange",{method:"POST",headers:{host:"localhost","content-type":"application/json"},body:JSON.stringify({...launch,code:new URL(choice.body.redirectTo).searchParams.get("code"),verifier})});expect(response.status).toBe(200);const issued=await response.json();
 const request={ticket:issued.ticket,handoffId:issued.id,reserveId:randomToken(),launch,binding:issued.binding};
 const authorization=`Bearer fixture-key.${secret}`;
 const send=(body:unknown=request,headers:Record<string,string>={})=>e.app.request(path,{method:"POST",headers:{host:"localhost","content-type":"application/json",authorization,...headers},body:JSON.stringify(body)});
 return {...e,person,user:user!,request,authorization,send};
}
