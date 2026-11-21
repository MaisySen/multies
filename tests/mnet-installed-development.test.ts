import { createServer as createViteServer } from "vite";
import { chromium } from "playwright";
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
const installed=process.env.MNET_DEVELOPMENT_SETUP_BINARY;
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function waitFile(path:string,done:()=>boolean){const deadline=Date.now()+60000;for(;;){try{return await readFile(path,"utf8");}catch{/* Wait for atomic fixture IPC publication. */}if(done()||Date.now()>deadline)throw new Error("workflow fixture IPC timeout");await sleep(10);}}
(repo&&installed?it:it.skip).each(["success"])("explicit installed disposable setup with actual browser %s",async(mode)=>{
 const dir=await mkdtemp(join(tmpdir(),"mnet-workflow-cross-"));await chmod(dir,0o700);
 const e=await setupBookkeeping(true);let child:ReturnType<typeof spawn>|undefined;let done=false;let output="";let exchangeCalls=0;let reserveCalls=0;let reserveStatus=0;
 const key=join(dir,"key.pem"),cert=join(dir,"cert.pem");
 execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",key,"-out",cert,"-days","1","-subj","/CN=127.0.0.1","-addext","subjectAltName=IP:127.0.0.1"],{stdio:"pipe"});await chmod(key,0o600);
 const vite=await createViteServer({server:{middlewareMode:true,fs:{allow:[process.cwd(),"/tmp/multies-mnet-integration/node_modules"]}},appType:"spa",optimizeDeps:{noDiscovery:true,include:["react","react-dom/client","react/jsx-runtime","react-router","@tanstack/react-query"]}});
 let browser:Awaited<ReturnType<typeof chromium.connectOverCDP>>|undefined;
 const server=createServer({key:await readFile(key),cert:await readFile(cert)},async(req,res)=>{
  if(!req.url?.startsWith("/api/")){vite.middlewares(req,res);return;}

  try{
   const service=req.url==="/api/mnet-enrollment-service-v1/reserve-evidence-v2";

   if(service){reserveCalls++;if(mode==="source-denied")await e.db.delete(members).where(eq(members.userId,e.user.id));}else if(req.url==="/api/mnet-enrollment-v1/exchange-v2")exchangeCalls++;
   const chunks:Buffer[]=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>16384){res.writeHead(413).end();return;}chunks.push(chunk);}
   const headers=new Headers();for(const [name,value]of Object.entries(req.headers)){if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(","):value);}
   const response=await e.app.request(`https://${req.headers.host}${req.url}`,{method:req.method,headers,...(req.method!=="GET"&&req.method!=="HEAD"?{body:Buffer.concat(chunks).toString("utf8")}:{})});if(service)reserveStatus=response.status;
   res.setHeader("set-cookie",response.headers.getSetCookie());res.writeHead(response.status,Object.fromEntries([...response.headers].filter(([key])=>key!=="set-cookie")));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(500).end();}
 });
 try{
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw new Error("missing TLS address");
  e.deps.config.appUrl=`https://127.0.0.1:${address.port}`;
  const nativeBinary=join(dir,"native-fixture.test");
  if(mode!=="source-denied")execFileSync("go",["test","-race","-tags","multies_native_fixture","-c","-o",nativeBinary,"./internal/daemon"],{cwd:repo,stdio:"pipe"});
  child=spawn("go",["test","-race","-tags","multies_native_fixture","./internal/control","-run","^TestActualMultiesRegistrarWorkflowFixture$","-count=1","-timeout","60s"],{cwd:repo,env:{...process.env,MNET_WORKFLOW_FIXTURE_DIR:dir,MNET_NATIVE_WORKFLOW_BINARY:nativeBinary,SSL_CERT_FILE:cert,SSL_CERT_DIR:join(dir,"no-extra-roots")},stdio:["ignore","pipe","pipe"]});
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
   const url=new URL(sourceOrigin+"/mnet/enroll-v1");for(const [key,value]of Object.entries(nativeLaunch))url.searchParams.set(key,String(value));
   // The installed native command opens the system browser. CDP drives that
   // actual opened page, not an API shortcut or a separately invented URL.
   for(let i=0;i<150&&!browser;i++){try{browser=await chromium.connectOverCDP("http://127.0.0.1:9237",{timeout:500});}catch{await sleep(100);}}
   if(!browser)throw new Error("system browser did not open "+output);
   const context=browser.contexts()[0];let page=context.pages().find(p=>p.url().includes("/mnet/enroll-v1")||p.url().includes("/login"));
   for(let i=0;i<100&&!page;i++){await sleep(100);page=context.pages().find(p=>p.url().includes("/mnet/enroll-v1")||p.url().includes("/login"));}
   if(!page)throw new Error("installed joining browser page missing");
   page.on("response",response=>{if(response.url().includes("/api/")&&response.status()>=400)console.log("HTTP",response.status(),response.url());});
   page.on("pageerror",error=>console.log("BROWSER",error.message));
   await page.locator('input[name="email"]').waitFor({timeout:60000});
   await page.screenshot({path:"/downloads/mnet-development-installed-login.png",fullPage:true});
   await page.locator('input[name="email"]').fill(e.person.email!);await page.locator('input[name="password"]').fill("a-strong-password");
   await page.getByRole("button",{name:"Sign in",exact:true}).click();
   await page.getByRole("heading",{name:"Approve this computer joining Mnet"}).waitFor({timeout:15000}).catch(async(error)=>{await page!.screenshot({path:"/downloads/mnet-development-installed-browser-failure.png",fullPage:true});console.log("FAILED PAGE",page!.url(),await page!.locator("body").innerText());throw error;});
   expect(await page.getByTestId("mnet-handoff-key").textContent()).toBe(nativeLaunch.devicePublicKey);
   await page.getByRole("combobox").selectOption(workspaceId);
   await page.screenshot({path:"/downloads/mnet-development-installed-consent.png",fullPage:true});
   await page.getByRole("button",{name:"Approve handoff",exact:true}).click();
   await page.getByRole("button",{name:"Return to Mnet",exact:true}).waitFor();
   await page.screenshot({path:"/downloads/mnet-development-installed-return.png",fullPage:true});
   await page.getByRole("button",{name:"Return to Mnet",exact:true}).click();
   await page.getByText("Approval returned to Mnet.",{exact:false}).waitFor();
   await page.screenshot({path:"/downloads/mnet-development-installed-callback.png",fullPage:true});


  }
  const outcome=JSON.parse(await waitFile(join(dir,"outcome.json"),()=>done).catch(error=>{throw new Error(`${String(error)}\n${output}`);}));const code=await completion;expect(code,output).toBe(0);
  expect(outcome).toMatchObject({developmentInstalled:true,nativeOwnedKeyConfirmed:true,nativeProofStateUnchanged:true,nativeStateFinalized:true,nodeDeleted:true,inputAuthorized:false});
  expect(outcome.nativeCurrentPeers).toBeGreaterThanOrEqual(0);
  expect(exchangeCalls).toBe(3);expect(reserveCalls).toBe(3);expect(reserveStatus).toBe(200);
  console.log("PASS installed development browser/owned native finalization/current map; actual peer count",outcome.nativeCurrentPeers);

 }finally{
  if(child&&!done){child.kill("SIGKILL");await new Promise<void>(resolve=>child!.once("close",()=>resolve()));}
  if(browser){try{await(await browser.newBrowserCDPSession()).send("Browser.close");}catch{}await browser.close();}
  await vite.close();
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  (e.db as unknown as {$client:{close():void}}).$client.close();if(e.indexDb)(e.indexDb as unknown as {$client:{close():void}}).$client.close();await rm(dir,{recursive:true,force:true});
 }
},100000);
