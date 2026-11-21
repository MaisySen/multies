import {it,expect} from "vitest";
import {createServer} from "node:https";
import {spawn,execFileSync} from "node:child_process";
import {mkdtemp,readFile,writeFile,rm,chmod,rename,mkdir,copyFile} from "node:fs/promises";
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
(repo?it:it.skip).each(["deny","withdraw-pending"])("actual enrolled WireGuard/proofnet attended fakeUI %s, no capture or input",async(caseName)=>{
 const mode="direct-transport" as string;
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
  const nativeBinary=join(dir,"native-fixture.test");
  execFileSync("go",["test","-race","-tags","multies_native_fixture,mnet_enrollment_development","-c","-o",nativeBinary,"./cmd/mnetd"],{cwd:repo,stdio:"pipe"});
  child=spawn("go",["test","-race","-tags","multies_native_fixture","./internal/control","-run","^TestActualMultiesRegistrarWorkflowFixture$","-count=1","-timeout","60s"],{cwd:repo,env:{...process.env,MNET_WORKFLOW_FIXTURE_DIR:dir,MNET_NATIVE_WORKFLOW_BINARY:nativeBinary,MNET_DEVELOPMENT_ATTENDED_FIXTURE:"1",MNET_DEVELOPMENT_ATTENDED_CASE:caseName,SSL_CERT_FILE:cert,SSL_CERT_DIR:join(dir,"no-extra-roots")},stdio:["ignore","pipe","pipe"]});
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
  if(mode!=="source-denied"){
   const peerLaunch=JSON.parse(await waitFile(join(dir,"peer-launch.json"),()=>done));
   const peerPrepared=await e.person.post("/api/mnet-enrollment-v1/authorizations",{...peerLaunch,workspaceId,displayed});expect(peerPrepared.status).toBe(201);
   const peerChoice=await e.person.post(`/api/mnet-enrollment-v1/authorizations/${peerPrepared.body.id}/decision`,{decision:"allow"});expect(peerChoice.status).toBe(200);
   await writeFile(join(dir,"peer-code.tmp"),JSON.stringify({code:new URL(peerChoice.body.redirectTo).searchParams.get("code")}),{mode:0o600});await rename(join(dir,"peer-code.tmp"),join(dir,"peer-code.json"));
   const nativeLaunch=JSON.parse(await waitFile(join(dir,"native-launch.json"),()=>done));
   const nativePrepared=await e.person.post("/api/mnet-enrollment-v1/authorizations",{...nativeLaunch,workspaceId,displayed});expect(nativePrepared.status).toBe(201);
   const nativeChoice=await e.person.post(`/api/mnet-enrollment-v1/authorizations/${nativePrepared.body.id}/decision`,{decision:"allow"});expect(nativeChoice.status).toBe(200);
   const callbackURL=new URL(nativeChoice.body.redirectTo);const expectedCallback=new URL(nativeLaunch.redirectUri);
   expect(callbackURL.origin).toBe(expectedCallback.origin);expect(callbackURL.pathname).toBe(expectedCallback.pathname);
   const callback=await fetch(callbackURL,{redirect:"error"});expect(callback.status).toBe(200);
   await writeFile(join(dir,"native-continue"),"test-only real callback completed",{mode:0o600});

  }
  const outcome=JSON.parse(await waitFile(join(dir,"outcome.json"),()=>done).catch(error=>{throw new Error(`${String(error)}\n${output}`);}));const code=await completion;expect(code,output).toBe(0);
  expect(exchangeCalls).toBe(mode!=="source-denied"?3:1);expect(reserveCalls).toBe(mode!=="source-denied"?3:1);expect(reserveStatus).toBe(mode!=="source-denied"?200:403);expect(outcome.inputAuthorized).toBe(false);
  if(caseName==="deny"){expect(outcome).toEqual({version:1,fake_ui:true,attendedDenied:true,actualEnrolledPeers:true,joined:true,inputAuthorized:false});}else{expect(outcome).toMatchObject({version:1,fake_ui:true,case:caseName,attendedDenied:true,actualEnrolledPeers:true,joined:true,inputAuthorized:false,promptCancelled:true});expect(outcome.localClose).toMatchObject({invoked:true,completed:true,joined:true});expect(outcome.localClose.elapsedMS).toBeLessThan(1000);expect(["explicit-protocol-refusal","eof-after-verified-withdrawal","closed-read-after-verified-withdrawal"]).toContain(outcome.transportClass);}
  const row=await e.db.select().from(journal).where(eq(journal.id,prepared.body.id)).get();expect(row!.status).toBe("reserved");
  const state=JSON.parse(await readFile(join(dir,"control","state.json"),"utf8"));expect(Object.keys(state.nodes)).toHaveLength(0);expect(Object.keys(state.node_tokens)).toHaveLength(0);

 }finally{
  if(child&&!done){child.kill("SIGKILL");await new Promise<void>(resolve=>child!.once("close",()=>resolve()));}
  const evidence=join("/downloads",`attended-enrolled-run-${Date.now()}`);await mkdir(evidence,{recursive:true});
  for(const name of ["peer-attended-coordinates.json","native-attended-listening.json","peer-attended-refused.json","native-attended-outcome.json","native-attended-pending.json","peer-attended-withdrawn.json","peer-attended-transport.json","native-attended-failed.json","outcome.json"]){try{await copyFile(join(dir,name),join(evidence,name));}catch{/* Missing IPC files are not success. */}}
  await writeFile(join(evidence,"control-output.log"),output,{mode:0o600});console.log(`Retained public-coordinate/counter/failure evidence at ${evidence}`);
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  (e.db as unknown as {$client:{close():void}}).$client.close();if(e.indexDb)(e.indexDb as unknown as {$client:{close():void}}).$client.close();await rm(dir,{recursive:true,force:true});
 }
},90000);
