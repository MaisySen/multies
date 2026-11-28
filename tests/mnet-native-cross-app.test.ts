import {it,expect} from "vitest";
import {createServer} from "node:https";
import {spawn,execFileSync} from "node:child_process";
import {mkdtemp,readFile,writeFile,rm,chmod} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomToken} from "@/server/lib/crypto";
import {eq} from "drizzle-orm";
import {setupBookkeeping} from "./mnet-enrollment-bookkeeping-fixture";
import {members,mnetEnrollmentHandoffs as journal} from "@/server/db/schema";

// Explicit opt-in actual-handler/DB/native integration, never a live service or
// browser UI acceptance. The operator fixture independently supplies native
// expected mapping/principal/service before any native exchange response.
const repo=process.env.MNET_NATIVE_REPO;
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function waitFile(path:string,done:()=>boolean){const until=Date.now()+45000;for(;;){try{return await readFile(path,"utf8");}catch{}if(done()||Date.now()>until)throw new Error("native fixture IPC deadline");await sleep(10);}}
(repo?it:it.skip).each(["success","decline","revoked","lost-response"])("actual Multies handler/DB to owned native %s",async(mode)=>{
 const dir=await mkdtemp(join(tmpdir(),"mnet-native-cross-"));await chmod(dir,0o700);
 const e=await setupBookkeeping(true);let child:ReturnType<typeof spawn>|undefined;let sourceCalls=0;let sourceStatus=0;let serviceCalls=0;let done=false;let output="";
 // Only disposable local TLS. Native uses normal platform verification with
 // this certificate in the test process roots, not an insecure client flag.
 const key=join(dir,"key.pem"),cert=join(dir,"cert.pem");
 execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",key,"-out",cert,"-days","1","-subj","/CN=127.0.0.1","-addext","subjectAltName=IP:127.0.0.1"],{stdio:"pipe"});await chmod(key,0o600);
 const server=createServer({key:await readFile(key),cert:await readFile(cert)},async(req,res)=>{
 try{
  const url = req.url;
  const service=url==="/api/mnet-enrollment-service-v1/reserve-evidence-v2";if(service)serviceCalls++;else sourceCalls++;
  if(req.method!=="POST"||(url!=="/api/mnet-enrollment-service-v1/reserve-evidence-v2"&&url!=="/api/mnet-enrollment-v1/exchange-v2")){res.writeHead(404).end();return;}
  const chunks:Buffer[]=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>16384){res.writeHead(413).end();return;}chunks.push(chunk);}
  const headers=new Headers();for(const [name,value]of Object.entries(req.headers)){if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(","):value);}headers.set("host","localhost");
  const response=await e.app.request(url,{method:"POST",headers,body:Buffer.concat(chunks).toString("utf8")});if(!service)sourceStatus=response.status;
  // Lose the response only AFTER the real source handler consumed the code
  // and committed its issued ticket. Do not synthesize a source response.
  if(mode==="lost-response"){await response.arrayBuffer();res.destroy();return;}
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(500).end();}
 });
 try{
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw new Error("missing local TLS address");
 const operator=e.deps.config.mnetEnrollmentOperator!;
 const policy={version:2,revision:operator.revision,source_origin:`https://127.0.0.1:${address.port}`,principal_authority:operator.provenance!.principalAuthority,principal_namespace:operator.provenance!.principalNamespace,issuer_label:operator.issuer,registrar_origin:operator.registrarOrigin,audience:operator.audience,service_id:"fixture-registrar",bindings:operator.bindings.map(b=>({workspace_id:b.workspaceId,network_id:b.networkId,principal_ids:[...b.principals]}))};
 await writeFile(join(dir,"fixture.json"),JSON.stringify({mode,policy}),{mode:0o600});
 child=spawn("go",["test","-race","-tags","multies_native_fixture","./internal/daemon","-run","^TestActualMultiesNativeFixture$","-count=1","-timeout","60s"],{cwd:repo,env:{...process.env,MNET_NATIVE_FIXTURE_DIR:dir,SSL_CERT_FILE:cert,SSL_CERT_DIR:join(dir,"no-extra-roots")},stdio:["ignore","pipe","pipe"]});
 child.stdout!.on("data",b=>{output+=b.toString();});child.stderr!.on("data",b=>{output+=b.toString();});const completion=new Promise<number|null>((resolve,reject)=>{child!.on("error",reject);child!.on("close",code=>{done=true;resolve(code);});});
 const launch=JSON.parse(await waitFile(join(dir,"launch.json"),()=>done));
 const binding=operator.bindings[0];const displayed={issuer:operator.issuer,registrarOrigin:operator.registrarOrigin,audience:operator.audience,mappingRevision:operator.revision,networkId:binding.networkId};
 const prepared=await e.person.post("/api/mnet-enrollment-v1/authorizations",{...launch,workspaceId:binding.workspaceId,displayed});expect(prepared.status).toBe(201);
 const decision=await e.person.post(`/api/mnet-enrollment-v1/authorizations/${prepared.body.id}/decision`,{decision:mode==="decline"?"decline":"allow"});expect(decision.status).toBe(200);
 const callback=await fetch(decision.body.redirectTo,{redirect:"error"});expect(callback.status).toBe(200);await callback.text();
 if(mode==="revoked")await e.db.delete(members).where(eq(members.userId,e.user.id));
 await writeFile(join(dir,"continue"),"ready",{mode:0o600});
 const outcome=JSON.parse(await waitFile(join(dir,"outcome.json"),()=>done));const code=await completion;expect(code,output).toBe(0);
 expect(outcome).toEqual({phase:mode==="success"?"exchanged-data":mode==="decline"?"declined-data":"exchange-may-have-started",stateUnchanged:true,nodeCreated:false,inputAuthorized:false});
 expect(sourceCalls).toBe(mode==="decline"?0:1);expect(sourceStatus).toBe(mode==="decline"?0:mode==="revoked"?403:200);
 const row=await e.db.select().from(journal).where(eq(journal.id,prepared.body.id)).get();expect(row!.status).toBe(mode==="decline"?"declined":mode==="revoked"?"withdrawn":"issued");
 if(mode==="success"){
 const native=JSON.parse(await readFile(join(dir,"native","enrollment-pending","enrollment-pending-v1.json"),"utf8"));const exchanged=JSON.parse(native.exchange_json);
 expect(exchanged.id===row!.id&&exchanged.provenance.principalId===row!.userId&&exchanged.provenance.sessionBinding===row!.sessionBinding&&exchanged.provenance.principalAuthority===row!.principalAuthority).toBe(true);
 expect(exchanged.binding.workspaceId===row!.workspaceId&&exchanged.binding.networkId===row!.networkId&&exchanged.launch.attemptId===row!.attemptId).toBe(true);
 const nativeStateBefore=await readFile(join(dir,"native","state.json"));
 const request={ticket:exchanged.ticket,handoffId:exchanged.id,reserveId:randomToken(),launch:exchanged.launch,binding:exchanged.binding};
 const independentlyConfiguredMapping={workspaceId:binding.workspaceId,issuer:operator.issuer,registrarOrigin:operator.registrarOrigin,audience:operator.audience,mappingRevision:operator.revision,networkId:binding.networkId};
 const serviceConfig={version:1,revision:"fixture-r1",max_concurrent:2,max_per_source:1,max_attempts:4,sources:[{id:"fixture",source_origin:policy.source_origin,principal_authority:policy.principal_authority,key_id:"fixture-key",service_id:"fixture-registrar",issuer_label:operator.issuer,registrar_origin:operator.registrarOrigin,audience:operator.audience,secret:e.authorization.slice("Bearer fixture-key.".length),timeout_ms:3000,max_connections:1,allowed:[independentlyConfiguredMapping]}]};
 await writeFile(join(dir,"registrar-fixture.json"),JSON.stringify({config:serviceConfig,request,exchange:exchanged}),{mode:0o600});
 const control=spawn("go",["test","-race","-tags","multies_native_fixture","./internal/control","-run","^TestActualMultiesStoreSourceFixture$","-count=1","-timeout","30s"],{cwd:repo,env:{...process.env,MNET_NATIVE_FIXTURE_DIR:dir,SSL_CERT_FILE:cert,SSL_CERT_DIR:join(dir,"no-extra-roots")},stdio:["ignore","pipe","pipe"]});
 child=control;done=false;let controlOutput="";control.stdout!.on("data",b=>{controlOutput+=b.toString();});control.stderr!.on("data",b=>{controlOutput+=b.toString();});
 const controlCode=await new Promise<number|null>((resolve,reject)=>{control.on("error",reject);control.on("close",code=>{done=true;resolve(code);});});expect(controlCode,controlOutput).toBe(0);
 const reserved=JSON.parse(await readFile(join(dir,"registrar-outcome.json"),"utf8"));const sourceRow=await e.db.select().from(journal).where(eq(journal.id,prepared.body.id)).get();
 expect(serviceCalls).toBe(1);expect(reserved.status).toBe("reserved");expect(reserved.authorityGranted).toBe(false);expect(reserved.enrolled).toBe(false);expect(sourceRow!.status).toBe("reserved");
 expect(reserved.provenance.sessionBinding===exchanged.provenance.sessionBinding&&reserved.provenance.principalId===exchanged.provenance.principalId&&reserved.descriptorDigest===sourceRow!.descriptorDigest&&reserved.reserveId===sourceRow!.reserveId).toBe(true);
 expect((await readFile(join(dir,"native","state.json"))).equals(nativeStateBefore)).toBe(true);
 
 }
 expect(row!.attemptId).toBe(launch.attemptId);expect(row!.devicePublicKey).toBe(launch.devicePublicKey);expect(row!.credentialDigest).toBe(launch.credentialDigest);
 }finally{
 if(child&&!done){child.kill("SIGKILL");await new Promise<void>(resolve=>child!.once("close",()=>resolve()));}
 server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
 (e.db as unknown as {$client:{close():void}}).$client.close();if(e.indexDb)(e.indexDb as unknown as {$client:{close():void}}).$client.close();await rm(dir,{recursive:true,force:true});
 }
},90000);
