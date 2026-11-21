import {createServer as createViteServer} from "vite";
import {chromium} from "playwright";
import {it,expect} from "vitest";
import {createServer,request} from "node:https";
import {spawn,execFileSync} from "node:child_process";
import {mkdtemp,readFile,writeFile,rm,chmod,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomBytes} from "node:crypto";
import {setupBookkeeping} from "./mnet-enrollment-bookkeeping-fixture";
const repo=process.env.MNET_NATIVE_REPO;
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
(repo&&process.env.MNET_PAIR_EXECUTION_REVIEWED==="1"?it:it.skip)("two actual installed owners and finite proof-before-HTTP userspace adapter",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"mnet-separate-service-"));await chmod(dir,0o700);const e=await setupBookkeeping(true);
 let service:ReturnType<typeof spawn>|undefined;let serviceDone=false;let serviceOut="",serviceErr="";const children:Array<ReturnType<typeof spawn>>=[];let reserveCalls=0,exchangeCalls=0;
 const key=join(dir,"source-key.pem"),cert=join(dir,"source-cert.pem");
 execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",key,"-out",cert,"-days","1","-subj","/CN=127.0.0.1","-addext","subjectAltName=IP:127.0.0.1"],{stdio:"pipe"});await chmod(key,0o600);
 const vite=await createViteServer({server:{middlewareMode:true,fs:{allow:[process.cwd(),"/tmp/multies-mnet-integration/node_modules"]}},appType:"spa",optimizeDeps:{noDiscovery:true,include:["react","react-dom/client","react/jsx-runtime","react-router","@tanstack/react-query"]}});
 let browser:Awaited<ReturnType<typeof chromium.connectOverCDP>>|undefined;
 const server=createServer({key:await readFile(key),cert:await readFile(cert)},async(req,res)=>{if(!req.url?.startsWith("/api/")){vite.middlewares(req,res);return;}try{
  const isService=req.url==="/api/mnet-enrollment-service-v1/reserve-evidence-v2";
  if(isService)reserveCalls++;else if(req.url==="/api/mnet-enrollment-v1/exchange-v2")exchangeCalls++;
  const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>16384){res.writeHead(413).end();return;}chunks.push(chunk);}
  const headers=new Headers();for(const [name,value]of Object.entries(req.headers))if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(","):value);
  const response=await e.app.request(`https://${req.headers.host}${req.url}`,{method:req.method,headers,...(req.method!=="GET"&&req.method!=="HEAD"?{body:Buffer.concat(chunks).toString("utf8")}: {})});res.setHeader("set-cookie",response.headers.getSetCookie());res.writeHead(response.status,Object.fromEntries([...response.headers].filter(([key])=>key!=="set-cookie")));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(500).end();}});
 try{
  const binary=join(dir,"registrar");
  execFileSync("go",["build","-tags","mnet_enrollment_development","-o",binary,"./cmd/mnet-registrar-admission-development"],{cwd:repo,stdio:"pipe"});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const address=server.address();if(!address||typeof address==="string")throw new Error("source address");const sourceOrigin=`https://127.0.0.1:${address.port}`;e.deps.config.appUrl=sourceOrigin;
  service=spawn(binary,["-parent",dir],{env:{...process.env,SSL_CERT_FILE:cert,SSL_CERT_DIR:join(dir,"no-extra-roots")},stdio:["pipe","pipe","pipe"]});
  service.stdout!.on("data",b=>{serviceOut+=b.toString();});service.stderr!.on("data",b=>{serviceErr+=b.toString();});const serviceCompletion=new Promise<number|null>((resolve,reject)=>{service!.on("error",reject);service!.on("close",c=>{serviceDone=true;resolve(c);});});
  const until=Date.now()+10000;while(!serviceOut.includes("\n")){if(serviceDone||Date.now()>until)throw new Error(`service launch failed ${serviceErr}`);await sleep(5);}
  const launch=JSON.parse(serviceOut.split("\n")[0]);expect(launch).toMatchObject({stage:"awaiting-disposable-configuration",hostedReady:false,durableQuota:false});expect(new URL(launch.origin).hostname).toBe("127.0.0.1");
  const operator=e.deps.config.mnetEnrollmentOperator!;operator.registrarOrigin=launch.origin;operator.bindings[0].networkId=launch.networkId;e.deps.config.mnetEnrollmentServiceFixture!.keys[0].registrarOrigin=launch.origin;
  const b=operator.bindings[0],mapping={workspaceId:b.workspaceId,issuer:operator.issuer,registrarOrigin:operator.registrarOrigin,audience:operator.audience,mappingRevision:operator.revision,networkId:b.networkId};
  const policy={version:2,revision:operator.revision,source_origin:sourceOrigin,principal_authority:operator.provenance!.principalAuthority,principal_namespace:operator.provenance!.principalNamespace,issuer_label:operator.issuer,registrar_origin:operator.registrarOrigin,audience:operator.audience,service_id:"fixture-registrar",bindings:[{workspace_id:b.workspaceId,network_id:b.networkId,principal_ids:[...b.principals]}]};
  const sources={version:1,revision:"workflow-source-r1",max_concurrent:2,max_per_source:1,max_attempts:8,sources:[{id:"fixture",source_origin:sourceOrigin,principal_authority:policy.principal_authority,key_id:"fixture-key",service_id:policy.service_id,issuer_label:operator.issuer,registrar_origin:operator.registrarOrigin,audience:operator.audience,secret:e.authorization.slice("Bearer fixture-key.".length),timeout_ms:3000,max_connections:1,allowed:[mapping]}]};
  const workflow={version:1,mode:"development",revision:"workflow-fixture-r1",source_id:"fixture",policy,challenge_ms:10000,max_lease_ms:15000,max_observation_age_ms:20000,clock_uncertainty_ms:1,max_live_per_principal:4,max_proof_attempts:4,max_live:4,max_attempts:8,max_records:8,max_state_bytes:1048576};
  service.stdin!.end(JSON.stringify({sources,workflow}));while(!serviceOut.includes("disposable-service-ready")){if(serviceDone||Date.now()>until)throw new Error(`service configure failed ${serviceErr}`);await sleep(5);}
  const combined=join(dir,"client-roots.pem");const serviceCert=await readFile(launch.certificatePath);await writeFile(combined,Buffer.concat([await readFile(cert),serviceCert]),{mode:0o600});
  const httpStatus=(path:string,method="POST")=>new Promise<number>((resolve,reject)=>{const req=request(launch.origin+path,{method,ca:serviceCert,headers:{authorization:"Bearer forged","content-type":"application/json"}},res=>{res.resume();res.on("end",()=>resolve(res.statusCode!));});req.on("error",reject);req.end("{}");});
  const statePath=join(launch.root,"registrar-only.store");const empty=await readFile(statePath);
  for(const path of ["/api/join","/api/map","/account/","/admin/api/state","/api/relay/ws","/oidc/start","/join/approve","/api/mnet-node-experimental-v1/%6dap","/api/mnet-node-experimental-v1/map?legacy=1"]){expect(await httpStatus(path)).not.toBe(200);}
  expect(await readFile(statePath)).toEqual(empty);expect(reserveCalls).toBe(0);
  await writeFile(join(dir,"client-config.json"),JSON.stringify(workflow),{mode:0o600});
  const setupBinary=process.env.MNET_DEVELOPMENT_SETUP_BINARY,pairBinary=process.env.MNET_DEVELOPMENT_PAIR_BINARY;
  if(!setupBinary||!pairBinary)throw new Error("explicit separately compiled setup and pair binaries required");
  const devtools=process.env.MNET_DEVELOPMENT_SETUP_DEVTOOLS_FILE;if(!devtools)throw new Error("owned browser required");
  const ownerEnv={...process.env,SSL_CERT_FILE:combined,SSL_CERT_DIR:join(dir,"no-extra-roots")};
  const stage=(stage:string,fields:Record<string,unknown>={})=>console.log("PAIR PHASE",JSON.stringify({stage,at_ms:Date.now(),...fields}));
  const owners:Array<{root:string;launch:Record<string,unknown>;out:string;err:string;child:ReturnType<typeof spawn>;completion:Promise<number|null>;page?:import("playwright").Page;image?:Buffer;pending?:Buffer;receipt?:Record<string,unknown>}>=[];
  // Both actual installed saves have separate private root/key/journal. All
  // browser approvals are prepared at Return before either callback commits.
  for(let i=0;i<2;i++){
   const root=join(dir,`installed-${i}`);await mkdir(root,{mode:0o700});
   await writeFile(join(root,"DISPOSABLE-MNET-SETUP"),"mnet-disposable-enrollment-v1\n",{mode:0o600});await writeFile(join(root,"enrollment-policy-v2.json"),JSON.stringify(policy),{mode:0o600});
   await writeFile(join(root,"workflow-limits.json"),JSON.stringify({Timeout:3000000000,MaxChallengeLifetime:10000000000,MaxReserveLifetime:60000000000,Timing:{MaxObservationAgeMS:20000,MaxLeaseMS:15000,ClockUncertaintyMS:1}}),{mode:0o600});
   const child=spawn(setupBinary,["--disposable-root",root,"--save-one-shot-connection","--open-browser"],{env:ownerEnv,stdio:["ignore","pipe","pipe"]});children.push(child);
   const owner={root,launch:{} as Record<string,unknown>,out:"",err:"",child,completion:Promise.resolve(null) as Promise<number|null>,page:undefined as import("playwright").Page|undefined};owners.push(owner);
   child.stdout!.on("data",b=>{owner.out+=b.toString();for(const line of owner.out.split("\n")){try{const e=JSON.parse(line);if(e.launch)owner.launch=e.launch;if(typeof e.stage==="string")stage("setup-event-observed",{owner:i,native_stage:e.stage});}catch{/* bounded incomplete event */}}});child.stderr!.on("data",b=>{owner.err+=b.toString();});owner.completion=new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});
   for(let tries=0;!owner.launch.devicePublicKey&&tries<200;tries++)await sleep(25);if(!owner.launch.devicePublicKey)throw new Error("actual installed launch missing");
   if(!browser)for(let tries=0;!browser&&tries<100;tries++){try{const [port,path]=(await readFile(devtools,"utf8")).trim().split("\n");if(!/^\d+$/.test(port)||!/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(path))throw new Error("invalid owned browser endpoint");browser=await chromium.connectOverCDP(`ws://127.0.0.1:${port}${path}`,{timeout:500});}catch{await sleep(50);}}
   if(!browser)throw new Error("owned browser absent");const context=browser.contexts()[0];
   for(let tries=0;!owner.page&&tries<100;tries++){owner.page=context.pages().find(p=>(p.url().includes("/mnet/enroll-v1")||p.url().includes("/login"))&&!owners.slice(0,i).some(o=>o.page===p));if(!owner.page)await sleep(50);}const page=owner.page;if(!page)throw new Error("actual consent page absent");
   // Session cookie may exist for the second page; never invent another user.
   await Promise.race([page.getByRole("heading",{name:"Approve this computer joining Mnet"}).waitFor(),page.locator('input[name="email"]').waitFor()]);
   if(await page.locator('input[name="email"]').isVisible()){await page.locator('input[name="email"]').fill(e.person.email!);await page.locator('input[name="password"]').fill("a-strong-password");await page.getByRole("button",{name:"Sign in",exact:true}).click();}
   await page.getByRole("heading",{name:"Approve this computer joining Mnet"}).waitFor();expect(await page.getByTestId("mnet-handoff-key").textContent()).toBe(owner.launch.devicePublicKey);await page.getByRole("combobox").selectOption(mapping.workspaceId);await page.getByRole("button",{name:"Approve handoff",exact:true}).click();await page.getByRole("button",{name:"Return to Mnet",exact:true}).waitFor();
   await page.screenshot({path:`/downloads/mnet-two-installed-owner-${i}-prepared.png`,fullPage:true});stage("browser-prepared",{owner:i});
  }
  expect(reserveCalls).toBe(0);expect(exchangeCalls).toBe(0);expect(owners[0].launch.devicePublicKey).not.toBe(owners[1].launch.devicePublicKey);
  stage("timing-build-mode",{race:false,requiredGo12611Proven:false});
  const workStart=Date.now();stage("callbacks-released",{work_start_ms:workStart});
  // Exactly one click per actual owner. Serial commits respect unchanged
  // max_per_source1. Both browser decisions were staged first. No retry.
  for(const [i,o]of owners.entries()){stage("callback-release",{owner:i});await o.page!.getByRole("button",{name:"Return to Mnet",exact:true}).click();expect(await o.completion,o.err+o.out).toBe(0);stage("save-exit",{owner:i});o.image=await readFile(join(o.root,"native","state.json"));o.pending=await readFile(join(o.root,"native","enrollment-pending","enrollment-pending-v1.json"));const state=JSON.parse(o.image.toString());const native=JSON.parse(state.native_enrollment_v1);o.receipt=native.document.receipt;expect(state.public_key).toBe(native.document.receipt.device_public_key);expect(state.public_key).toBe(Buffer.from(o.launch.devicePublicKey as string,"base64url").toString("base64"));}
  // These are untrusted DATA leads only; each adapter independently checks the
  // saved receipt and live authenticated map before binding or listening.
  const storePrefix="MNET-DISPOSABLE-REGISTRAR-ONLY-STORE-V2\n",storeImage=await readFile(statePath,"utf8");expect(storeImage.startsWith(storePrefix)).toBe(true);const store=JSON.parse(storeImage.slice(storePrefix.length));
  const earlierExpiry=Math.min(...owners.map(o=>Number(o.receipt!.access_expires_at_ms)));if(!Number.isSafeInteger(earlierExpiry))throw new Error("original expiry missing");expect(Number(owners[0].receipt!.committed_at_ms)).toBeLessThanOrEqual(Number(owners[1].receipt!.committed_at_ms));expect(Number(owners[0].receipt!.access_expires_at_ms)).toBe(earlierExpiry);stage("expiry-order",{earlier_owner:"A",b_earlier_covered:false,earlier_expiry_ms:earlierExpiry});
  const nodes=owners.map(o=>{const key=o.receipt!.device_public_key;const candidates=(Object.values(store.nodes) as Array<Record<string,unknown>>).filter(n=>n.pubkey===key);if(candidates.length!==1)throw new Error("exact saved node/key missing");const n=candidates[0];const ip=n.ipv4;const nodeID=n.id;expect(nodeID).toBe(o.receipt!.node_id);if(typeof ip!=="string")throw new Error("node IP missing");return {key,ip};});
  if(Date.now()-workStart>1000)throw new Error("harness-inconclusive: dual saves exceeded proposed1s, no connect launch");
  const body=randomBytes(32).toString("hex");
  const pairConfigs=await Promise.all(owners.map(async(o,i)=>{const path=join(dir,`pair-${i}.json`);await writeFile(path,JSON.stringify({version:1,role:i===0?"dial":"listen",self_key:nodes[i].key,peer_key:nodes[1-i].key,self_ip:nodes[i].ip,peer_ip:nodes[1-i].ip,earlier_expiry_ms:earlierExpiry,work_start_ms:workStart,body_hex:body}),{mode:0o600});return {root:o.root,path};}));
  const adapters=pairConfigs.map(({root,path},i)=>{const spawnMS=Date.now();const child=spawn(pairBinary,["--disposable-root",root,"--public-config",path],{env:ownerEnv,stdio:["pipe","pipe","pipe"]});children.push(child);const a={child,out:"",err:"",events:[] as Array<Record<string,unknown>>,completion:Promise.resolve(null) as Promise<number|null>};let partial="";child.stdout!.on("data",b=>{a.out+=b.toString();partial+=b.toString();for(;;){const at=partial.indexOf("\n");if(at<0)break;const line=partial.slice(0,at);partial=partial.slice(at+1);try{const event=JSON.parse(line);a.events.push(event);stage("adapter-stage-observed",{owner:i,native_stage:event.stage,spawn_ms:spawnMS,native_at_ms:event.at_ms,spawn_to_native_stage_ms:Number(event.at_ms)-spawnMS});}catch{/* invalid output fails assertions */}}});child.stderr!.on("data",b=>{a.err+=b.toString();});a.completion=new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});stage("connect-launch",{owner:i});return a;});
  const assertClassified=()=>{const failures=adapters.flatMap(a=>a.events.filter(e=>e.stage==="pair-failed"));const hard=failures.find(e=>e.classification!=="inconclusive");if(hard)throw new Error("safety-or-contract-failed: "+JSON.stringify(hard));if(failures.length)throw new Error("harness-inconclusive: "+JSON.stringify(failures));};
  const untilReady=Math.min(workStart+3000,earlierExpiry-1000);while(!adapters[1].events.some(e=>e.stage==="pair-listener-ready")){assertClassified();if(adapters.some(a=>a.child.exitCode!==null)||Date.now()>untilReady)throw new Error("harness-inconclusive: exact listener not ready in envelope");await sleep(5);}
  adapters[0].child.stdin!.end("peer-ready\n");adapters[1].child.stdin!.end();stage("listener-gate-forwarded");
  const untilEnded=earlierExpiry+3000;while(adapters.some(a=>a.child.exitCode===null&&a.child.signalCode===null)){if(Date.now()>untilEnded)throw new Error("adapter cleanup deadline missed");await sleep(10);}
  assertClassified();
  for(const [i,a]of adapters.entries()){console.log("PAIR OUTPUT",i,a.out,a.err);expect(await a.completion,a.err+a.out).toBe(0);expect(a.events.some(e=>e.stage==="pair-finished")).toBe(true);expect(await readFile(join(owners[i].root,"native","state.json"))).toEqual(owners[i].image);expect(await readFile(join(owners[i].root,"native","enrollment-pending","enrollment-pending-v1.json"))).toEqual(owners[i].pending);const ledger=JSON.parse(await readFile(join(owners[i].root,"native","local-development-connection-v1.json"),"utf8"));expect(ledger.phase).toBe("connection-reserved");expect(ledger.local_connection_reserved).toBe(14);}
  expect(adapters[0].events.find(e=>e.stage==="pair-http-verified")?.at_ms).toBeLessThanOrEqual(Math.min(workStart+9000,earlierExpiry-1000));expect(adapters[0].events.some(e=>e.stage==="pair-post-expiry-denied"&&e.new_dial_denied===true&&e.old_stream_ack_denied===true)).toBe(true);
  expect(adapters[1].events.filter(e=>e.stage==="pair-server-proof")).toHaveLength(2);expect(adapters[1].events.filter(e=>e.stage==="pair-server-proof"||e.stage==="pair-http-served"||e.stage==="pair-old-stream-live-proof").every(e=>Number(e.at_ms)<earlierExpiry)).toBe(true);expect(adapters[1].events.filter(e=>e.stage==="pair-http-served")).toHaveLength(1);expect(adapters[1].events.filter(e=>e.stage==="pair-old-stream-live-proof")).toHaveLength(1);expect(adapters[1].events.some(e=>e.stage==="pair-accept-loop-joined")).toBe(true);expect(adapters[1].events.some(e=>e.stage==="pair-listener-closed"&&e.proof_count===2&&e.http_count===1&&e.old_live_proof_count===1)).toBe(true);
  expect(exchangeCalls).toBe(2);expect(reserveCalls).toBe(2);expect(store.admission_ledger.source_total).toBe(2);expect(Object.keys(store.nodes)).toHaveLength(2);expect(Object.keys(store.node_tokens)).toHaveLength(0);expect(Object.keys(store.auth_keys)).toHaveLength(0);
  service.kill("SIGTERM");expect(await serviceCompletion,serviceErr).toBe(0);stage("paired-feasibility-finished",{twoActualInstalledOwners:true,explicitBrowsers:true,userspaceOnly:true,originalEarlierExpiryMS:earlierExpiry,workStartMS:workStart,production:false,claim:"owner-scope-retirement-and-application-io-only",independentTunnelEnforcement:false,bEarlierCovered:false});
 }catch(error){const message=error instanceof Error?error.message:String(error);console.log("PAIR CLASSIFICATION",JSON.stringify({classification:message.startsWith("harness-inconclusive:")?"inconclusive":"failed-safety-or-contract",error:message}));throw error;
 }finally{
  if(browser){try{await(await browser.newBrowserCDPSession()).send("Browser.close");}catch{/* already closed */}await browser.close();}await vite.close();
  for(const child of [...children,service])if(child&&child.exitCode===null&&child.signalCode===null){child.kill("SIGKILL");await new Promise<void>(r=>child.once("close",()=>r()));}
  server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));(e.db as unknown as {$client:{close():void}}).$client.close();if(e.indexDb)(e.indexDb as unknown as {$client:{close():void}}).$client.close();await rm(dir,{recursive:true,force:true});
 }
},90000);
