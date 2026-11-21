import { chromium } from 'playwright';
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const repo=process.argv[2];if(!repo)throw new Error('exact original Mnet checkout required');
const sourcePath=join(repo,'cmd/mnet-setup-development/dashboard.go');
const source=await readFile(sourcePath,'utf8');
const html=source.match(/const dashboardHTML = `([\s\S]*?)`/)[1].replaceAll('%s','fixture-client-order');
const server=createServer((_req,res)=>res.writeHead(200,{'Content-Type':'text/html'}).end(html));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage({viewport:{width:1050,height:900}});
 let first;let requests=0;
 const firstReady=new Promise(resolve=>{first=resolve;});
 let release;
 const blocked=new Promise(resolve=>{release=resolve;});
 await page.route('**/state',async route=>{
  requests++;
  if(requests===1){first();await blocked;await route.fulfill({contentType:'application/json',body:JSON.stringify({state:'active',reason:'',peers:[]})});return;}
  await route.fulfill({contentType:'application/json',body:JSON.stringify({state:'ended',reason:'Fixture owners have joined.',peers:[]})});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await firstReady;
 await page.getByRole('heading',{name:'Network ended',exact:true}).waitFor({timeout:3000});
 await page.screenshot({path:'/downloads/mnet-dashboard-client-order-ended.png',fullPage:true});
 release();
 await page.getByRole('heading',{name:'Network active',exact:true}).waitFor({timeout:3000});
 await new Promise(resolve=>setTimeout(resolve,500));
 const body=await page.locator('body').innerText();
 await page.screenshot({path:'/downloads/mnet-dashboard-client-order-stale-active.png',fullPage:true});
 const result={exactSource:sourcePath,sourceSHA256:createHash('sha256').update(source).digest('hex'),fixtureOnly:true,requests,heading:await page.locator('h1').innerText(),staleActiveAfterEnded:body.includes('Network active'),details:'Actual client script. First state response deliberately delayed until after a later ended response rendered. No native network was started.'};
 await writeFile('/downloads/mnet-dashboard-client-order-result.json',JSON.stringify(result,null,2)+'\n');
 console.log(result);
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
