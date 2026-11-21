// Evidence-only helpers. Never persist setup stdout, native State, journal,
// receipt documents, callback URLs, launch objects or credential fields.
import {mkdirSync,appendFileSync,writeFileSync,readFileSync} from "node:fs";
import {join} from "node:path";
import type {ChildProcess} from "node:child_process";
export function explicitExitFailure(exitCode:number|null,signal:string|null,stderr:string):string|null{
 if(exitCode===null&&signal===null)return null;
 // A nonzero pre-stage exit is not a measured listener timing miss.
 return `early-process-exit: code=${exitCode} signal=${signal??"none"} stderr=${stderr.slice(0,4096)}`;
}
export function publicOwnerSummary(root:string){
 const read=(path:string)=>{try{return {value:JSON.parse(readFileSync(path,"utf8")),error:null};}catch(e){return {value:null,error:e instanceof Error?(e as NodeJS.ErrnoException).code??"unreadable":"unreadable"};}};
 const ledger=read(join(root,"native","local-development-connection-v1.json"));const journal=read(join(root,"native","enrollment-pending","enrollment-pending-v1.json"));
 return {ledger_error:ledger.error,journal_error:journal.error,ledger:ledger.value?{phase:ledger.value.phase,local_total:ledger.value.local_total,local_setup_reserved:ledger.value.local_setup_reserved,local_connection_reserved:ledger.value.local_connection_reserved}:null,journal:journal.value?{phase:journal.value.phase,version:journal.value.version}:null};
}
export function createPublicEvidence(dir:string){
 mkdirSync(dir,{recursive:true,mode:0o700});
 const event=(value:Record<string,unknown>)=>appendFileSync(join(dir,"public-events.jsonl"),JSON.stringify({at_ms:Date.now(),...value})+"\n",{mode:0o600});
 const snapshot=(phase:string,roots:string[])=>event({kind:"owner-summaries",phase,owners:roots.map(publicOwnerSummary)});
 const track=(child:ChildProcess,label:string,publicStdout:boolean)=>{
  const spawnMS=Date.now();event({kind:"process-spawn",label,pid:child.pid??null,spawn_ms:spawnMS});let stderr="",partial="",stderrBytes=0;
  child.stderr?.on("data",b=>{const text=String(b);stderrBytes+=Buffer.byteLength(text);stderr=(stderr+text).slice(0,16384);writeFileSync(join(dir,label+".stderr.txt"),stderr,{mode:0o600});});
  if(publicStdout)child.stdout?.on("data",b=>{partial+=String(b);for(;;){const at=partial.indexOf("\n");if(at<0)break;const line=partial.slice(0,at);partial=partial.slice(at+1);try{const e=JSON.parse(line);event({kind:"public-native-event",label,event:e,spawn_to_stage_ms:Number(e.at_ms)-spawnMS});}catch{event({kind:"invalid-public-event",label});}}});
  child.once("error",e=>event({kind:"process-error",label,error:e.message}));child.once("close",(code,signal)=>event({kind:"process-exit",label,code,signal,stderr,stderr_bytes_seen:stderrBytes,stderr_truncated:stderrBytes>16384,elapsed_ms:Date.now()-spawnMS}));
 };
 return {event,snapshot,track};
}
