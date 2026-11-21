import {it,expect} from "vitest";
import {createServer} from "node:https";
import {spawn,execFileSync} from "node:child_process";
import {mkdtemp,readFile,writeFile,rm,chmod,rename} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {eq} from "drizzle-orm";
import {members,mnetEnrollmentHandoffs as journal} from "@/server/db/schema";
import {setupBookkeeping} from "./mnet-enrollment-bookkeeping-fixture";

// Opt-in real Multies approval/PKCE/SQLite/source -> private Go crypto/atomic
// Store workflow. No registered registrar ingress, native State or real device.
const repo=process.env.MNET_NATIVE_REPO;
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function waitFile(path:string,done:()=>boolean){const deadline=Date.now()+60000;for(;;){try{return await readFile(path,"utf8");}catch{/* Wait for atomic fixture IPC publication. */}if(done()||Date.now()>deadline)throw new Error("workflow fixture IPC timeout");await sleep(10);}}
(repo?it:it.skip).each(["success","source-denied"])("actual Multies approval/source to atomic registrar workflow %s",async(mode)=>{
 const dir=await mkdtemp(join(tmpdir(),"mnet-workflow-cross-"));await chmod(dir,0o700);
 const e=await setupBookkeeping(true);let child:ReturnType<typeof spawn>|undefined;let done=false;let output="";let exchangeCalls=0;let reserveCalls=0;let reserveStatus=0;
 const key=join(dir,"key.pem"),cert=join(dir,"cert.pem");
 execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",key,"-out",cert,"-days","1","-subj","/CN=127.0.0.1","-addext","subjectAltName=IP:127.0.0.1"],{stdio:"pipe"});await chmod(key,0o600);
 const server=createServer({key:await readFile(key),cert:await readFile(cert)},async(req,res)=>{
  try{
   const service=req.url==="/api/mnet-enrollment-service-v1/reserve-evidence-v2";
   if(req.method!=="POST"||!service&&req.url!=="/api/mnet-enrollment-v1/exchange-v2"){res.writeHead(404).end();return;}
   if(service){reserveCalls++;if(mode==="source-denied")await e.db.delete(members).where(eq(members.userId,e.user.id));}else exchangeCalls++;
   const chunks:Buffer[]=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>16384){res.writeHead(413).end();return;}chunks.push(chunk);}
   const headers=new Headers();for(const [name,value]of Object.entries(req.headers)){if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(","):value);}headers.set("host","localhost");
   const response=await e.app.request(req.url!,{method:"POST",headers,body:Buffer.concat(chunks).toString("utf8")});if(service)reserveStatus=response.status;
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(500).end();}
 });
 try{
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw new Error("missing TLS address");
  child=spawn("go",["test","-race","-tags","multies_native_fixture","./internal/control","-run","^TestActualMultiesRegistrarWorkflowFixture$","-count=1","-timeout","60s"],{cwd:repo,env:{...process.env,MNET_WORKFLOW_FIXTURE_DIR:dir,SSL_CERT_FILE:cert,SSL_CERT_DIR:join(dir,"no-extra-roots")},stdio:["ignore","pipe","pipe"]});
  child.stdout!.on("data",b=>{output+=b.toString();});child.stderr!.on("data",b=>{output+=b.toString();});const completion=new Promise<number|null>((resolve,reject)=>{child!.on("error",reject);child!.on("close",code=>{done=true;resolve(code);});});
  const publicInput=JSON.parse(await waitFile(join(dir,"launch.json"),()=>done));
  const operator=e.deps.config.mnetEnrollmentOperator!;operator.bindings[0].networkId=publicInput.networkId;operator.registrarOrigin=publicInput.registrarOrigin;e.deps.config.mnetEnrollmentServiceFixture!.keys[0].registrarOrigin=publicInput.registrarOrigin;
  const b=operator.bindings[0],mapping={workspaceId:b.workspaceId,issuer:operator.issuer,registrarOrigin:operator.registrarOrigin,audience:operator.audience,mappingRevision:operator.revision,networkId:b.networkId};
  const {workspaceId,...displayed}=mapping;
  const prepared=await e.person.post("/api/mnet-enrollment-v1/authorizations",{...publicInput.launch,workspaceId,displayed});expect(prepared.status).toBe(201);
  const choice=await e.person.post(`/api/mnet-enrollment-v1/authorizations/${prepared.body.id}/decision`,{decision:"allow"});expect(choice.status).toBe(200);
  const sourceOrigin=`https://127.0.0.1:${address.port}`;
  const policy={version:2,revision:operator.revision,source_origin:sourceOrigin,principal_authority:operator.provenance!.principalAuthority,principal_namespace:operator.provenance!.principalNamespace,issuer_label:operator.issuer,registrar_origin:operator.registrarOrigin,audience:operator.audience,service_id:"fixture-registrar",bindings:[{workspace_id:b.workspaceId,network_id:b.networkId,principal_ids:[...b.principals]}]};
  const sources={version:1,revision:"workflow-source-r1",max_concurrent:2,max_per_source:1,max_attempts:8,sources:[{id:"fixture",source_origin:sourceOrigin,principal_authority:policy.principal_authority,key_id:"fixture-key",service_id:policy.service_id,issuer_label:operator.issuer,registrar_origin:operator.registrarOrigin,audience:operator.audience,secret:e.authorization.slice("Bearer fixture-key.".length),timeout_ms:3000,max_connections:1,allowed:[mapping]}]};
  // Explicit test-only registrar-issued duration. NOT a source lease field,
  // production default, immediate account-revocation promise or activation.
  const workflow={version:1,mode:"development",revision:"workflow-fixture-r1",source_id:"fixture",policy,challenge_ms:10000,max_lease_ms:15000,max_observation_age_ms:20000,clock_uncertainty_ms:1,max_live_per_principal:4,max_proof_attempts:4,max_live:4,max_attempts:8,max_records:8,max_state_bytes:1048576};
  await writeFile(join(dir,"coordinator.tmp"),JSON.stringify({mode,code:new URL(choice.body.redirectTo).searchParams.get("code"),sources,workflow}),{mode:0o600});await rename(join(dir,"coordinator.tmp"),join(dir,"coordinator.json"));
  if(mode==="success"){
   const peerLaunch=JSON.parse(await waitFile(join(dir,"peer-launch.json"),()=>done));
   const peerPrepared=await e.person.post("/api/mnet-enrollment-v1/authorizations",{...peerLaunch,workspaceId,displayed});expect(peerPrepared.status).toBe(201);
   const peerChoice=await e.person.post(`/api/mnet-enrollment-v1/authorizations/${peerPrepared.body.id}/decision`,{decision:"allow"});expect(peerChoice.status).toBe(200);
   await writeFile(join(dir,"peer-code.tmp"),JSON.stringify({code:new URL(peerChoice.body.redirectTo).searchParams.get("code")}),{mode:0o600});await rename(join(dir,"peer-code.tmp"),join(dir,"peer-code.json"));
  }
  const outcome=JSON.parse(await waitFile(join(dir,"outcome.json"),()=>done));const code=await completion;expect(code,output).toBe(0);
  expect(exchangeCalls).toBe(mode==="success"?2:1);expect(reserveCalls).toBe(mode==="success"?2:1);expect(reserveStatus).toBe(mode==="success"?200:403);expect(outcome.inputAuthorized).toBe(false);
  const row=await e.db.select().from(journal).where(eq(journal.id,prepared.body.id)).get();
  if(mode==="success"){
   expect(outcome).toMatchObject({sourceDenied:false,nodeCreated:true,nodeDeleted:true,currentMapBeforeDelete:true,legacyTokenCreated:false,bidirectionalActualPeers:true,journalWorkflowReceiptPinned:true});
   expect(row!.status).toBe("reserved");expect(row!.reserveId).toBe(outcome.reserveId);expect(row!.descriptorDigest).toBe(outcome.descriptorDigest);expect(row!.devicePublicKey).toBe(publicInput.launch.devicePublicKey);expect(JSON.parse(row!.events)).toHaveLength(1);
   // No fabricated source acknowledgement: real Store receipt is separate and
   // source remains reserved. Bookkeeping/ack does not create network authority.
   expect(row!.receiptId).toBeNull();expect(row!.receiptDigest).toBeNull();
   const state=JSON.parse(await readFile(join(dir,"control","state.json"),"utf8"));const records=Object.values(state.registrar_state.records) as {receipt_id:string;receipt_digest:string;phase:string}[];
   expect(records).toHaveLength(2);expect(records.every(r=>r.phase==="revoked")).toBe(true);expect(records.find(r=>r.receipt_id===outcome.receiptId)).toMatchObject({receipt_id:outcome.receiptId,receipt_digest:outcome.receiptDigest,phase:"revoked"});expect(Object.keys(state.nodes)).toHaveLength(0);expect(Object.keys(state.node_tokens)).toHaveLength(0);
  }else{expect(outcome).toMatchObject({sourceDenied:true,nodeCreated:false});expect(row!.status).toBe("issued");}
 }finally{
  if(child&&!done){child.kill("SIGKILL");await new Promise<void>(resolve=>child!.once("close",()=>resolve()));}
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  (e.db as unknown as {$client:{close():void}}).$client.close();if(e.indexDb)(e.indexDb as unknown as {$client:{close():void}}).$client.close();await rm(dir,{recursive:true,force:true});
 }
},90000);
