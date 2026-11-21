// Disposable local API/browser/callback fixture only. No installed native client
// or registrar is exercised. Run from repository root with tsx.
import { createServer } from "node:http";
import { createServer as createVite } from "vite";
import { getRequestListener } from "@hono/node-server";
import { chromium } from "playwright";
import { makeTestApp, Client } from "../../tests/helpers";
import { eq } from "drizzle-orm";
import { users, members, organizations, mnetEnrollmentHandoffs } from "../../src/server/db/schema";
import { randomBytes, createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
const directory = "/downloads/mnet-handoff-journal";await mkdir(directory,{recursive:true});
const policy={consentMs:600000,codeMs:60000,ticketMs:120000,fullRowRetentionMs:86400000,capacity:10,maxRows:100,retention:"terminal-hash-tombstone"};
const random=()=>randomBytes(32).toString("base64url"), verifier=random(), credential=random();
const digest=(s:string)=>createHash("sha256").update(s).digest("base64url");
const e=await makeTestApp({MNET_ENROLLMENT_HANDOFF:"on",MNET_ENROLLMENT_HANDOFF_FIXTURE:JSON.stringify(policy),APP_URL:"http://localhost:5184"});
const person=new Client(e.app);await person.signup("handoff-fixture@example.test");
const user=await e.db.select().from(users).where(eq(users.email,person.email!)).get();await e.db.update(users).set({emailVerified:true}).where(eq(users.id,user!.id));
const member=await e.db.select().from(members).where(eq(members.userId,user!.id)).get();
const firstWorkspace=await e.db.select().from(organizations).where(eq(organizations.id,member!.organizationId)).get();
const selectedWorkspace=random();await e.db.insert(organizations).values({...firstWorkspace!,id:selectedWorkspace,name:"Second workspace",slug:"second-"+random().slice(0,12)});await e.db.insert(members).values({...member!,id:random(),organizationId:selectedWorkspace});
e.deps.config.mnetEnrollmentOperator={revision:"fixture-r1",issuer:"https://issuer.test/path",registrarOrigin:"https://registrar.test",audience:"fixture-enrollment",bindings:[{workspaceId:member!.organizationId,networkId:"net-fixture",principals:[user!.id]},{workspaceId:selectedWorkspace,networkId:"net-browser-selected-second",principals:[user!.id]}]};
const callback=createServer();await new Promise<void>(resolve=>callback.listen(0,"127.0.0.1",resolve));const callbackPort=(callback.address() as {port:number}).port;
const launch={version:1,purpose:"mnet-enrollment",attemptId:random(),devicePublicKey:random(),credentialDigest:digest(credential),challenge:digest(verifier),state:random(),platform:"linux",redirectUri:`http://127.0.0.1:${callbackPort}/mnet/enrollment/callback`};
let exchanged=false;let receivedBinding:unknown;
callback.on("request",async(req,res)=>{
 if (req.url === "/favicon.ico") { res.statusCode=404;res.end();return; }
 try{
  const u=new URL(req.url!,launch.redirectUri);assert.equal(u.pathname,"/mnet/enrollment/callback");assert.equal(u.searchParams.get("state"),launch.state);assert.equal(u.searchParams.get("attemptId"),launch.attemptId);
  res.setHeader("Cache-Control","no-store");res.setHeader("Referrer-Policy","no-referrer");
  const code=u.searchParams.get("code");assert.match(code!,/^[A-Za-z0-9_-]{43}$/);
  // Consumer knows only its own saved launch/code/verifier, not browser choice.
  const proof={...launch,code,verifier};
  const exchange=()=>e.app.request("/api/mnet-enrollment-v1/exchange",{method:"POST",headers:{host:"localhost","content-type":"application/json"},body:JSON.stringify(proof)});
  const result=await exchange();assert.equal(result.status,200);const body=await result.json();assert.match(body.ticket,/^[A-Za-z0-9_-]{43}$/);assert.equal(body.enrolled,false);assert.equal(body.registrarConnected,false);assert.equal(body.credential,undefined);assert.equal((await exchange()).status,403);
  receivedBinding=body.binding;exchanged=true;res.setHeader("content-type","text/html");res.end("<!doctype html><html><body style='font:18px system-ui;max-width:650px;margin:80px auto;padding:25px'><h1>Local fixture handoff received</h1><p>One-use code exchanged once. Repeat exchange refused.</p><p>Registrar not connected. No node or screen access exists.</p><p>This callback is an acceptance fixture, not an installed Mnet enrollment client.</p></body></html>");
 }catch(error){console.error("callback check failed",String(error));res.statusCode=500;res.end("Fixture handoff failed");}
});
const vite=await createVite({server:{middlewareMode:true,fs:{allow:["/tmp/multies-mnet-enrollment","/tmp/multies-mnet-integration/node_modules"]}},appType:"spa",optimizeDeps:{noDiscovery:true,include:["react","react-dom/client","react/jsx-runtime","react-router","@tanstack/react-query"]}});
const api=getRequestListener(e.app.fetch),server=createServer((req,res)=>req.url?.startsWith("/api/")?api(req,res):vite.middlewares(req,res));await new Promise<void>(resolve=>server.listen(5184,"127.0.0.1",resolve));
const browser=await chromium.launch({executablePath:"/usr/bin/google-chrome",headless:true,args:["--no-sandbox"]});
try{
 const page=await browser.newPage({viewport:{width:1280,height:1000}});const qs=new URLSearchParams(Object.entries(launch).map(([k,v])=>[k,String(v)]));
 await page.goto("http://localhost:5184/mnet/enroll-v1?"+qs);
 await page.locator('input[name="email"]').waitFor({timeout:60000});await page.screenshot({path:directory+"/signed-out-login.png",fullPage:true});
 await page.locator('input[name="email"]').fill("handoff-fixture@example.test");await page.locator('input[name="password"]').fill("a-strong-password");await page.getByRole("button",{name:"Sign in",exact:true}).click();
 await page.getByRole("heading",{name:"Approve this computer joining Mnet"}).waitFor({timeout:20000});assert.equal(await page.getByTestId("mnet-handoff-key").textContent(),launch.devicePublicKey);
 await page.getByRole("combobox").selectOption({label:"Second workspace"});await page.screenshot({path:directory+"/handoff-approval.png",fullPage:true});
 await page.getByRole("button",{name:"Approve handoff",exact:true}).click();await page.getByRole("heading",{name:"Approval ready for Mnet"}).waitFor();await page.screenshot({path:directory+"/handoff-return.png",fullPage:true});
 await page.getByRole("button",{name:"Return to Mnet",exact:true}).click();await page.getByRole("heading",{name:"Local fixture handoff received"}).waitFor();assert.equal(exchanged,true);await page.screenshot({path:directory+"/fixture-callback.png",fullPage:true});
 const row=await e.db.select().from(mnetEnrollmentHandoffs).get();assert.equal(row!.status,"issued");assert.equal(row!.workspaceId,selectedWorkspace);assert.deepEqual(receivedBinding,{workspaceId:selectedWorkspace,issuer:row!.issuer,registrarOrigin:row!.registrarOrigin,audience:row!.audience,mappingRevision:row!.mappingRevision,networkId:"net-browser-selected-second"});assert.equal(row!.credentialDigest,launch.credentialDigest);assert.equal(row!.codeHash,null);assert.notEqual(row!.ticketHash,null);
 // Fresh intent decline emits no code/ticket and cannot affect the first row.
 const declineLaunch={...launch,attemptId:random(),state:random()};
 await page.goto("http://localhost:5184/mnet/enroll-v1?"+new URLSearchParams(Object.entries(declineLaunch).map(([k,v])=>[k,String(v)])));
 await page.getByRole("combobox").selectOption({label:"Second workspace"});await page.getByRole("button",{name:"Decline",exact:true}).click();await page.getByRole("heading",{name:"Computer not approved"}).waitFor();await page.screenshot({path:directory+"/handoff-declined.png",fullPage:true});
 const rows=await e.db.select().from(mnetEnrollmentHandoffs);assert.equal(rows.filter(r=>r.status==="declined"&&r.codeHash===null&&r.ticketHash===null).length,1);const declined=true;
 console.log("PASS signed-out actual browser login/return, exact native-shaped tuple, consent, literal loopback fixture callback, one-shot real API exchange, decline; no installed native client, key proof, registrar or node activated",{exchanged,declined});
} finally {await browser.close();server.close();callback.close();await vite.close();}
