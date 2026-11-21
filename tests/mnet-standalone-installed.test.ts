import {createServer as createViteServer} from "vite";
import {chromium} from "playwright";
import {it,expect} from "vitest";
import {createServer,request} from "node:https";
import {spawn,execFileSync} from "node:child_process";
import {mkdtemp,readFile,writeFile,rm,chmod,rename,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setupBookkeeping} from "./mnet-enrollment-bookkeeping-fixture";
const repo=process.env.MNET_NATIVE_REPO;
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function waitFile(path:string,failed:()=>boolean){const until=Date.now()+45000;for(;;){try{return await readFile(path,"utf8");}catch{/* Await bounded fixture IPC only. */}if(failed()||Date.now()>until)throw new Error(`external client did not produce ${path}`);await sleep(10);}}
(repo?it:it.skip)("actual installed save/connect with standalone registrar and disposable encrypted TCP counterpart",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"mnet-separate-service-"));await chmod(dir,0o700);const e=await setupBookkeeping(true);
 let service:ReturnType<typeof spawn>|undefined,client:ReturnType<typeof spawn>|undefined;let serviceDone=false,clientDone=false;let serviceOut="",serviceErr="",clientOut="";let reserveCalls=0,exchangeCalls=0;
 const key=join(dir,"source-key.pem"),cert=join(dir,"source-cert.pem");
 execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",key,"-out",cert,"-days","1","-subj","/CN=127.0.0.1","-addext","subjectAltName=IP:127.0.0.1"],{stdio:"pipe"});await chmod(key,0o600);
 const vite=await createViteServer({server:{middlewareMode:true,fs:{allow:[process.cwd(),"/tmp/multies-mnet-integration/node_modules"]}},appType:"spa",optimizeDeps:{noDiscovery:true,include:["react","react-dom/client","react/jsx-runtime","react-router","@tanstack/react-query"]}});
 let browser:Awaited<ReturnType<typeof chromium.connectOverCDP>>|undefined;let installed:ReturnType<typeof spawn>|undefined;let installedOut="",installedErr="";let installedLaunch:Record<string,unknown>|undefined;let installedCompletion:Promise<number|null>|undefined;
 const server=createServer({key:await readFile(key),cert:await readFile(cert)},async(req,res)=>{if(!req.url?.startsWith("/api/")){vite.middlewares(req,res);return;}try{
  const isService=req.url==="/api/mnet-enrollment-service-v1/reserve-evidence-v2";
  if(isService)reserveCalls++;else if(req.url==="/api/mnet-enrollment-v1/exchange-v2")exchangeCalls++;
  const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>16384){res.writeHead(413).end();return;}chunks.push(chunk);}
  const headers=new Headers();for(const [name,value]of Object.entries(req.headers))if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(","):value);
  const response=await e.app.request(`https://${req.headers.host}${req.url}`,{method:req.method,headers,...(req.method!=="GET"&&req.method!=="HEAD"?{body:Buffer.concat(chunks).toString("utf8")}: {})});res.setHeader("set-cookie",response.headers.getSetCookie());res.writeHead(response.status,Object.fromEntries([...response.headers].filter(([key])=>key!=="set-cookie")));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(500).end();}});
 try{
  const binary=join(dir,"registrar"),clientBinary=join(dir,"client.test");
  execFileSync("go",["build","-tags","mnet_enrollment_development","-o",binary,"./cmd/mnet-registrar-development"],{cwd:repo,stdio:"pipe"});
  execFileSync("go",["test","-race","-tags","multies_native_fixture","-c","-o",clientBinary,"./internal/control"],{cwd:repo,stdio:"pipe"});
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
  const setupBinary=process.env.MNET_DEVELOPMENT_SETUP_BINARY;if(!setupBinary)throw new Error("explicit installed setup binary required");
  const root=join(dir,"installed-setup");await mkdir(root,{mode:0o700});
  await writeFile(join(root,"DISPOSABLE-MNET-SETUP"),"mnet-disposable-enrollment-v1\n",{mode:0o600});await writeFile(join(root,"enrollment-policy-v2.json"),JSON.stringify(policy),{mode:0o600});
  await writeFile(join(root,"workflow-limits.json"),JSON.stringify({Timeout:3000000000,MaxChallengeLifetime:10000000000,MaxReserveLifetime:60000000000,Timing:{MaxObservationAgeMS:20000,MaxLeaseMS:15000,ClockUncertaintyMS:1}}),{mode:0o600});
  installed=spawn(setupBinary,["--disposable-root",root,"--save-one-shot-connection","--open-browser"],{env:{...process.env,SSL_CERT_FILE:combined,SSL_CERT_DIR:join(dir,"no-extra-roots")},stdio:["ignore","pipe","pipe"]});
  installed.stdout!.on("data",chunk=>{installedOut+=chunk.toString();for(const line of installedOut.split("\n")){try{const event=JSON.parse(line);if(event.launch)installedLaunch=event.launch;}catch{/* incomplete event */}}});installed.stderr!.on("data",b=>{installedErr+=b.toString();});installedCompletion=new Promise((resolve,reject)=>{installed!.on("error",reject);installed!.on("close",resolve);});
  for(let tries=0;!installedLaunch&&tries<200;tries++)await sleep(25);if(!installedLaunch)throw new Error("installed launch missing "+installedErr);
  const devtools=process.env.MNET_DEVELOPMENT_SETUP_DEVTOOLS_FILE;if(!devtools)throw new Error("owned browser required");
  for(let tries=0;!browser&&tries<100;tries++){try{const [port,path]=(await readFile(devtools,"utf8")).trim().split("\n");if(!/^\d+$/.test(port)||!/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(path))throw new Error("invalid owned browser endpoint");browser=await chromium.connectOverCDP(`ws://127.0.0.1:${port}${path}`,{timeout:500});}catch{await sleep(50);}}
  if(!browser)throw new Error("owned browser missing");const context=browser.contexts()[0];let page=context.pages().find(p=>p.url().includes("/mnet/enroll-v1")||p.url().includes("/login"));for(let tries=0;!page&&tries<100;tries++){await sleep(50);page=context.pages().find(p=>p.url().includes("/mnet/enroll-v1")||p.url().includes("/login"));}if(!page)throw new Error("installed consent page absent");
  await page.locator('input[name="email"]').waitFor();await page.locator('input[name="email"]').fill(e.person.email!);await page.locator('input[name="password"]').fill("a-strong-password");await page.getByRole("button",{name:"Sign in",exact:true}).click();await page.getByRole("heading",{name:"Approve this computer joining Mnet"}).waitFor();expect(await page.getByTestId("mnet-handoff-key").textContent()).toBe(installedLaunch.devicePublicKey);await page.getByRole("combobox").selectOption(mapping.workspaceId);await page.getByRole("button",{name:"Approve handoff",exact:true}).click();await page.getByRole("button",{name:"Return to Mnet",exact:true}).waitFor();
  await page.screenshot({path:"/downloads/mnet-standalone-installed-prepared-return.png",fullPage:true});
  client=spawn(clientBinary,["-test.run=^TestStandaloneInstalledTCPPeerFixture$","-test.v","-test.timeout=50s"],{env:{...process.env,MNET_TEST_STANDALONE_INSTALLED_DIR:dir,SSL_CERT_FILE:combined,SSL_CERT_DIR:join(dir,"no-extra-roots")},stdio:["ignore","pipe","pipe"]});
  client.stdout!.on("data",b=>{clientOut+=b.toString();});client.stderr!.on("data",b=>{clientOut+=b.toString();});const clientCompletion=new Promise<number|null>((resolve,reject)=>{client!.on("error",reject);client!.on("close",c=>{clientDone=true;resolve(c);});});
  for(let i=0;i<1;i++){
   const nativeLaunch=JSON.parse(await waitFile(join(dir,`client-${i}-launch.json`),()=>clientDone));const {workspaceId,...displayed}=mapping;
   const prepared=await e.person.post("/api/mnet-enrollment-v1/authorizations",{...nativeLaunch,workspaceId,displayed});expect(prepared.status).toBe(201);
   const choice=await e.person.post(`/api/mnet-enrollment-v1/authorizations/${prepared.body.id}/decision`,{decision:"allow"});expect(choice.status).toBe(200);
   await writeFile(join(dir,`client-${i}-code.tmp`),JSON.stringify({code:new URL(choice.body.redirectTo).searchParams.get("code")}),{mode:0o600});await rename(join(dir,`client-${i}-code.tmp`),join(dir,`client-${i}-code.json`));
  }

  const timing=JSON.parse(await waitFile(join(dir,"installed-peers-ready"),()=>clientDone));expect(timing.accessExpiresAtMS-Date.now()).toBeGreaterThan(0);console.log("ORIGINAL STANDALONE PEER CLOCK",{...timing,now:Date.now()});
  await page.getByRole("button",{name:"Return to Mnet",exact:true}).click();expect(await installedCompletion,installedErr+installedOut).toBe(0);
  await writeFile(join(dir,"installed-saved"),"actual save command exited before connect",{mode:0o600});
  const saved=await readFile(join(root,"native","state.json"));const pendingImage=await readFile(join(root,"native","enrollment-pending","enrollment-pending-v1.json"));
  await waitFile(join(dir,"counterpart-configured"),()=>clientDone);
  installedOut="";installedErr="";installed=spawn(setupBinary,["--disposable-root",root,"--connect-existing-once","--open-browser"],{env:{...process.env,SSL_CERT_FILE:combined,SSL_CERT_DIR:join(dir,"no-extra-roots")},stdio:["ignore","pipe","pipe"]});installed.stdout!.on("data",b=>{installedOut+=b.toString();});installed.stderr!.on("data",b=>{installedErr+=b.toString();});installedCompletion=new Promise((resolve,reject)=>{installed!.on("error",reject);installed!.on("close",resolve);});
  for(let tries=0;!installedOut.includes("development-network-verified")&&tries<200;tries++)await sleep(25);expect(installedOut,installedErr).toContain("development-network-verified");
  let live=context.pages().find(p=>p.url().startsWith("http://127.0.0.1")&&!p.url().includes("callback"));for(let tries=0;tries<100;tries++){live=context.pages().find(p=>p.url().startsWith("http://127.0.0.1")&&!p.url().includes("callback"));if(live&&await live.title().catch(()=>"")==="Mnet disposable network")break;await sleep(25);}if(!live)throw new Error("live dashboard absent");await live.getByRole("heading",{name:"Network active",exact:true}).waitFor();expect(await live.locator("#peers li").count()).toBe(1);await live.screenshot({path:"/downloads/mnet-standalone-installed-active.png",fullPage:true});await live.getByRole("heading",{name:"Network ended",exact:true}).waitFor({timeout:20000});await live.getByText("The original approved peer lease ended.",{exact:false}).waitFor();expect(await live.locator("#peers li").count()).toBe(0);expect(await live.getByRole("button",{name:"Stop network",exact:true}).isDisabled()).toBe(true);await live.screenshot({path:"/downloads/mnet-standalone-installed-ended.png",fullPage:true});
  expect(await installedCompletion,installedErr+installedOut).toBe(0);const ledger=JSON.parse(await readFile(join(root,"native","local-development-connection-v1.json"),"utf8"));expect(ledger.phase).toBe("connection-reserved");expect(await readFile(join(root,"native","state.json"))).toEqual(saved);expect(await readFile(join(root,"native","enrollment-pending","enrollment-pending-v1.json"))).toEqual(pendingImage);
  expect(JSON.parse(await waitFile(join(dir,"clients-current.json"),()=>clientDone))).toMatchObject({installedTCPVerified:true,journalOwnedProof:true,counterpartNativeStateInstalled:false,inputAuthorized:false});
  const image=await readFile(statePath,"utf8");const prefix="MNET-DISPOSABLE-REGISTRAR-ONLY-STORE-V1\n";expect(image.startsWith(prefix)).toBe(true);const state=JSON.parse(image.slice(prefix.length));expect(Object.keys(state.nodes)).toHaveLength(2);expect(Object.keys(state.node_tokens)).toHaveLength(0);expect(Object.keys(state.auth_keys)).toHaveLength(0);expect(Object.keys(state.registrar_state.records)).toHaveLength(2);
  expect(JSON.parse(await waitFile(join(dir,"clients-ended.json"),()=>clientDone))).toMatchObject({originalExpiryRefused:true,renewalImplemented:false});expect(await clientCompletion,clientOut).toBe(0);expect(exchangeCalls).toBe(2);expect(reserveCalls).toBe(2);
  service.kill("SIGTERM");expect(await serviceCompletion,serviceErr).toBe(0);
  console.log("EXTERNAL SERVICE EVIDENCE",JSON.stringify({separateRegistrarProcess:true,separateNativeClientProcess:true,realMultiesSource:true,exchangeCalls,reserveCalls,twoActualPeers:true,originalExpiryRefused:true,legacyTokens:0,legacyAuthKeys:0,prefixedDiskImage:true,hostedReady:false,durableQuota:false,nativeStateInstalled:true,actualInstalledSaveExitBeforeConnect:true,encryptedTCPVerified:true,originalIntervalUnchanged:true,inputAuthorized:false}));
 }finally{
  console.log("EXTERNAL CLIENT OUTPUT",clientOut);console.log("INSTALLED OUTPUT",installedOut,installedErr);if(serviceErr)console.log("EXTERNAL SERVICE STDERR",serviceErr);
  if(browser){try{await(await browser.newBrowserCDPSession()).send("Browser.close");}catch{/* already closed */}await browser.close();}await vite.close();
  for(const child of [installed,client,service])if(child&&child.exitCode===null&&child.signalCode===null){child.kill("SIGKILL");await new Promise<void>(r=>child.once("close",()=>r()));}
  server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));(e.db as unknown as {$client:{close():void}}).$client.close();if(e.indexDb)(e.indexDb as unknown as {$client:{close():void}}).$client.close();await rm(dir,{recursive:true,force:true});
 }
},90000);
