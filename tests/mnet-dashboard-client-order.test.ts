import {it,expect} from "vitest";
import {chromium} from "playwright";
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
const repo=process.env.MNET_NATIVE_REPO;
(repo?it:it.skip)("exact dashboard client serializes reads and keeps ended terminal",async()=>{
 const source=await readFile(join(repo!,"cmd/mnet-setup-development/dashboard.go"),"utf8");
 const template=source.match(/const dashboardHTML = `([\s\S]*?)`/);
 if(!template)throw new Error("exact dashboard source template missing");
 const html=template[1].replaceAll("%s","fixture-client-order");
 const server=createServer((_req,res)=>res.writeHead(200,{"Content-Type":"text/html"}).end(html));
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const browser=await chromium.launch({executablePath:"/usr/bin/google-chrome",headless:true,args:["--no-sandbox"]});
 let release:()=>void=()=>{};
 try{
  const page=await browser.newPage({viewport:{width:1050,height:900}});
  let requests=0,inflight=0,maxInflight=0;
  let firstReady:()=>void=()=>{};
  const first=new Promise<void>(resolve=>{firstReady=resolve;});
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  await page.route("**/state",async route=>{
   const request=++requests;inflight++;maxInflight=Math.max(maxInflight,inflight);
   try{
    if(request===1){firstReady();await blocked;}
    await route.fulfill({contentType:"application/json",body:JSON.stringify({state:request===1?"active":"ended",reason:request===1?"":"Fixture owners have joined.",peers:[]})});
   }finally{inflight--;}
  });
  const address=server.address();if(!address||typeof address==="string")throw new Error("fixture address missing");
  await page.goto(`http://127.0.0.1:${address.port}`);await first;
  // Multiple actual browser timer cycles pass while the first response is held.
  // This is a deliberate race stimulus, not an external-page readiness sleep.
  await page.waitForTimeout(450);
  expect(requests,"overlapping status reads allow response-order regressions").toBe(1);
  release();
  await page.getByRole("heading",{name:"Network ended",exact:true}).waitFor({timeout:3000});
  const atEnd=requests;
  await page.waitForTimeout(450);
  expect(requests).toBe(atEnd);expect(maxInflight).toBe(1);
  expect(await page.locator("h1").innerText()).toBe("Network ended");
  expect(await page.locator("#peers li").count()).toBe(0);
  expect(await page.getByRole("button",{name:"Stop network",exact:true}).isDisabled()).toBe(true);
  await page.screenshot({path:"/downloads/mnet-dashboard-client-order-fixed.png",fullPage:true});
 }finally{release();await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
},10000);

(repo?it:it.skip).each(["stop-late-active","stopping-late-active","unavailable","ended-late-stop-error","stop-error-active"])("exact client keeps controls fail-closed for %s",async scenario=>{
 const source=await readFile(join(repo!,"cmd/mnet-setup-development/dashboard.go"),"utf8");
 const template=source.match(/const dashboardHTML = `([\s\S]*?)`/);if(!template)throw new Error("template missing");
 const server=createServer((_req,res)=>res.writeHead(200,{"Content-Type":"text/html"}).end(template[1].replaceAll("%s","fixture-client-order")));
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const browser=await chromium.launch({executablePath:"/usr/bin/google-chrome",headless:true,args:["--no-sandbox"]});
 let release:()=>void=()=>{};
 try{
  const page=await browser.newPage({viewport:{width:1050,height:900}});
  let requests=0,stopRequested=false;
  let pendingReady:()=>void=()=>{};const pending=new Promise<void>(resolve=>{pendingReady=resolve;});
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  const active={state:"active",reason:"",peers:[{Name:"fixture-current-peer",IPv4:"100.64.0.2"}]};
  const ended={state:"ended",reason:"Fixture owners have joined.",peers:[]};
  await page.route("**/stop",async route=>{
   stopRequested=true;
   if(scenario==="ended-late-stop-error"){pendingReady();await blocked;}
   await route.fulfill({status:scenario.includes("error")?500:202,body:""});
  });
  await page.route("**/state",async route=>{
   const request=++requests;
   if(scenario==="stop-late-active"&&request===2){pendingReady();await blocked;}
   if(scenario==="unavailable"&&request===2){await route.abort();return;}
   if(scenario==="unavailable"&&request===3){pendingReady();await blocked;}
   const state=scenario==="stopping-late-active"&&request===2?{state:"stopping",reason:"",peers:[]}:scenario==="ended-late-stop-error"&&stopRequested||scenario==="unavailable"&&request>=3?ended:active;
   await route.fulfill({contentType:"application/json",body:JSON.stringify(state)});
  });
  const address=server.address();if(!address||typeof address==="string")throw new Error("fixture address missing");
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.getByRole("heading",{name:"Network active",exact:true}).waitFor({timeout:3000});
  if(scenario==="stop-late-active"){
   await pending;await page.getByRole("button",{name:"Stop network",exact:true}).click();
   await page.getByRole("heading",{name:"Stopping network",exact:true}).waitFor();release();
  }else if(scenario==="stopping-late-active"){
   await page.getByRole("heading",{name:"Stopping network",exact:true}).waitFor();
  }else if(scenario==="unavailable"){
   await pending;await page.getByRole("heading",{name:"Live status unavailable",exact:true}).waitFor();
   expect(await page.locator("#peers li").count()).toBe(0);
   expect(await page.getByRole("button",{name:"Stop network",exact:true}).isDisabled()).toBe(true);
   release();await page.getByRole("heading",{name:"Network ended",exact:true}).waitFor();
  }else if(scenario==="ended-late-stop-error"){
   await page.getByRole("button",{name:"Stop network",exact:true}).click();await pending;
   await page.getByRole("heading",{name:"Network ended",exact:true}).waitFor();release();
  }else{
   await page.getByRole("button",{name:"Stop network",exact:true}).click();
   await page.getByText("Stop was not confirmed.",{exact:false}).waitFor();
  }
  await page.waitForTimeout(450);
  expect(await page.locator("h1").innerText()).toBe(scenario==="unavailable"||scenario==="ended-late-stop-error"?"Network ended":"Stopping network");
  expect(await page.locator("#peers li").count()).toBe(0);
  expect(await page.getByRole("button",{name:"Stop network",exact:true}).isDisabled()).toBe(true);
  if(scenario==="ended-late-stop-error")expect(await page.locator("#status").innerText()).toBe("Fixture owners have joined.");
 }finally{release();await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
},10000);
