import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { approvalBatch, witnessSql, ownRevokeSql, DB_NOW_MS } from '../experiments/mnet-relationship-store/store';
import { sourceSchema, seedSql } from '../experiments/mnet-relationship-store/fixture';
const schema=readFileSync('experiments/mnet-relationship-store/schema.sql','utf8');
const dbs: Database.Database[]=[];
function fresh(file=':memory:') {const d=new Database(file);dbs.push(d);d.exec(sourceSchema);d.exec(schema);d.exec(seedSql);return d;}
function approve(d:Database.Database,id='approval_a',explicit=true) {return d.transaction(()=>approvalBatch('ses_a','org_a',id,'d'.repeat(43),explicit).map(s=>d.prepare(s.sql).run(...s.values)))();}
function witness(d:Database.Database,id='approval_a',w='witness_a') {return d.prepare(witnessSql).run(w,id).changes;}
function status(d:Database.Database){return d.prepare('SELECT status FROM rel_approvals LIMIT 1').pluck().get();}
function epoch(d:Database.Database){return d.prepare('SELECT generation FROM rel_security LIMIT 1').pluck().get() as number;}
afterEach(()=>{for(const d of dbs.splice(0))d.close();});
describe('isolated authoritative relationship store',()=>{
 it('initializes first approval atomically, explicit self-session only, and emits witness DATA only',()=>{
  const d=fresh();approve(d,'not_explicit',false);expect(d.prepare('SELECT count(*) FROM rel_approvals').pluck().get()).toBe(0);
  approve(d);expect(epoch(d)).toBe(0);expect(witness(d)).toBe(1);expect(d.prepare('SELECT * FROM rel_witness').get()).toEqual({id:'witness_a',approval_id:'approval_a'});
  expect(()=>approve(d)).toThrow();expect(d.prepare('SELECT count(*) FROM rel_approvals').pluck().get()).toBe(1);
 });
 for(const [name,sql] of [
  ['ban','UPDATE users SET banned=1'],['unverified','UPDATE users SET email_verified=0'],['disabled','UPDATE members SET disabled_at=1'],['agent','UPDATE members SET kind=\'agent\''],['workspace','UPDATE organizations SET suspended_at=1'],['demo','UPDATE organizations SET is_demo=1'],['impersonated','UPDATE sessions SET impersonated_by=\'operator\''],['expired','UPDATE sessions SET expires_at=1'],['missing session','DELETE FROM sessions'],['sso','UPDATE members SET role=\'member\'; UPDATE organizations SET require_sso=1']]) {
  it(`refuses approval and consumption with current ${name}`,()=>{const d=fresh();approve(d);d.exec(sql);expect(witness(d)).toBe(0);approve(d,'second');expect(d.prepare('SELECT count(*) FROM rel_approvals').pluck().get()).toBe(1);});
 }
 const mutations:[string,string,string][]=[
  ['password','INSERT INTO accounts VALUES(\'acc_a\',\'usr_a\',\'credential\',\'hash1\')','UPDATE accounts SET password=\'hash2\''],
  ['email','','UPDATE users SET email=\'new@example.test\''],['verification','','UPDATE users SET email_verified=0'],['ban','','UPDATE users SET banned=1'],
  ['role','','UPDATE members SET role=\'admin\''],['kind','','UPDATE members SET kind=\'agent\''],['disabled','','UPDATE members SET disabled_at=1'],['SSO','','UPDATE organizations SET require_sso=1'],['suspension','','UPDATE organizations SET suspended_at=1'],['demo','','UPDATE organizations SET is_demo=1'],
 ];
 for(const [name,setup,mutation] of mutations)it(`sticky ${name} mutation, no resurrection on restoring old source`,()=>{
  const d=fresh();d.exec(setup);approve(d);const g=epoch(d);d.exec(mutation);expect(status(d)).toBe('revoked');expect(witness(d)).toBe(0);
  d.exec("UPDATE users SET email='a@example.test',email_verified=1,banned=0; UPDATE members SET role='owner',kind='human',disabled_at=NULL; UPDATE organizations SET require_sso=0,suspended_at=NULL,is_demo=0;");expect(witness(d)).toBe(0);expect(epoch(d)).toBeGreaterThanOrEqual(g);approve(d,'fresh_approval');expect(witness(d,'fresh_approval')).toBe(1);
 });
 it('ignores no-op assignments and normal OAuth refresh',()=>{const d=fresh();approve(d);d.exec("UPDATE users SET email=email,email_verified=email_verified,banned=banned; UPDATE members SET role=role,kind=kind,disabled_at=disabled_at; UPDATE organizations SET require_sso=require_sso,suspended_at=suspended_at,is_demo=is_demo; UPDATE sessions SET login_method=login_method,expires_at=expires_at; INSERT INTO accounts VALUES('oauth','usr_a','google','one'); UPDATE accounts SET password='two' WHERE id='oauth';");expect(epoch(d)).toBe(0);expect(witness(d)).toBe(1);});
 it('retains user/member/org tombstones through cascades and same-ID recreation',()=>{
  for(const table of ['users','members','organizations']){const d=fresh();approve(d);d.exec(`DELETE FROM ${table}`);expect(status(d)).toBe('revoked');expect(witness(d)).toBe(0);d.exec('DELETE FROM accounts;DELETE FROM sessions;DELETE FROM members;DELETE FROM organizations;DELETE FROM users;');d.exec(seedSql);expect(status(d)).toBe('revoked');expect(witness(d)).toBe(0);expect(()=>d.exec("UPDATE rel_approvals SET status='approved'")).toThrow('immutable');approve(d,'fresh');expect(witness(d,'fresh')).toBe(1);}
 });
 it('expired-session cleanup does not globally fence, active deletion does; DB milliseconds only',()=>{
  const d=fresh();approve(d);const now=d.prepare(`SELECT ${DB_NOW_MS}`).pluck().get() as number;expect(Number.isSafeInteger(now)).toBe(true);expect(now).toBeGreaterThan(1e12);
  d.prepare('INSERT INTO sessions VALUES(?,?,?,NULL,?)').run('old','usr_a',now-10000,'email');d.exec("DELETE FROM sessions WHERE id='old'");expect(epoch(d)).toBe(0);expect(status(d)).toBe('approved');
  d.prepare('INSERT INTO sessions VALUES(?,?,?,NULL,?)').run('active','usr_a',now+60000,'email');d.exec("DELETE FROM sessions WHERE id='active'");expect(epoch(d)).toBeGreaterThan(0);expect(witness(d)).toBe(0);
 });
 it('fails closed on driver-safe counter bound and never wraps/re-enables',()=>{const d=fresh();approve(d);d.exec('UPDATE rel_security SET generation=9007199254740991');d.exec("UPDATE users SET email='b@example.test'");expect(epoch(d)).toBe(Number.MAX_SAFE_INTEGER);expect(d.prepare('SELECT disabled FROM rel_security').pluck().get()).toBe(1);approve(d,'fresh');expect(d.prepare('SELECT count(*) FROM rel_approvals').pluck().get()).toBe(1);});
 it('failed source statement rolls back trigger and original change together',()=>{
  const d=fresh();approve(d);d.exec("CREATE TRIGGER injected_abort AFTER UPDATE ON rel_security BEGIN SELECT RAISE(ABORT,'injected'); END;");expect(()=>d.exec("UPDATE users SET email='x@example.test'")).toThrow('injected');expect(epoch(d)).toBe(0);expect(status(d)).toBe('approved');expect(d.prepare('SELECT email FROM users').pluck().get()).toBe('a@example.test');
 });
 it('first-approval batch rolls initialization back on failure',()=>{const d=fresh();expect(()=>d.transaction(()=>{for(const s of approvalBatch('ses_a','org_a','a','d',true))d.prepare(s.sql).run(...s.values);d.exec('INSERT INTO absent VALUES(1)');})()).toThrow();expect(d.prepare('SELECT count(*) FROM rel_security').pluck().get()).toBe(0);expect(d.prepare('SELECT count(*) FROM rel_approvals').pluck().get()).toBe(0);});
 it('own revoke works after membership loss, but other/impersonated actors cannot revoke',()=>{const d=fresh();approve(d);d.exec("INSERT INTO users VALUES('other','o@example.test',1,0);INSERT INTO sessions VALUES('other_s','other',4102444800000,NULL,'email');");expect(d.prepare(ownRevokeSql).run('approval_a','other_s').changes).toBe(0);d.exec("UPDATE members SET disabled_at=1;");expect(d.prepare(ownRevokeSql).run('approval_a','ses_a').changes).toBe(0);approve(d,'not_added');d.exec("UPDATE members SET disabled_at=NULL;");approve(d,'new');d.exec("DELETE FROM members;");expect(status(d)).toBe('revoked');});
 it('documents unsupported REPLACE blind spot, while scanning actual source for protected-table use',()=>{const d=fresh();approve(d);d.exec("INSERT OR REPLACE INTO sessions VALUES('ses_a','usr_a',4102444800000,NULL,'email')");expect(epoch(d)).toBe(0);expect(witness(d)).toBe(1);const files=(dir:string):string[]=>readdirSync(dir).flatMap(n=>{const p=join(dir,n);return statSync(p).isDirectory()?files(p):[p];});for(const p of files('src'))expect(readFileSync(p,'utf8')).not.toMatch(/(?:insert\s+or\s+replace\s+into|replace\s+into)\s+["`[]?(?:sessions|accounts|users|members|organizations)\b/i);});
 it('survives process death after committed mutation and rolls uncommitted mutation back',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rel-crash-'));try{for(const commit of [true,false]){
   const path=join(dir,`crash-${commit}.db`),d=fresh(path);approve(d);
   const child=spawn(process.execPath,['-e',`const D=require(process.argv[1]),d=new D(process.argv[2]);if(process.argv[3]==='false')d.exec('BEGIN IMMEDIATE');d.exec("UPDATE users SET email='crashed@example.test'");process.send('mutated');setInterval(()=>{},1000);`,createRequire(import.meta.url).resolve('better-sqlite3'),path,String(commit)],{stdio:['ignore','pipe','pipe','ipc']});
   await new Promise<void>((resolve,reject)=>{child.once('message',()=>{child.kill('SIGKILL');});child.once('error',reject);child.once('exit',(_code,signal)=>{if(signal==='SIGKILL')resolve();else reject(new Error('unexpected exit'));});});
   expect(status(d)).toBe(commit?'revoked':'approved');expect(witness(d)).toBe(commit?0:1);
  }}finally{rmSync(dir,{recursive:true,force:true});}
 });
 it('pins PK changes, session changes, credential unlink and missing fence',()=>{
  for(const sql of ["UPDATE members SET id='new_member'","UPDATE sessions SET id='new_session'","UPDATE sessions SET login_method='google'","UPDATE sessions SET impersonated_by='operator'","UPDATE sessions SET expires_at=1","DELETE FROM accounts"]){const d=fresh();d.exec("INSERT INTO accounts VALUES('a','usr_a','credential','hash')");approve(d);d.exec(sql);expect(witness(d)).toBe(0);expect(status(d)).toBe('revoked');}
  const d=fresh();approve(d);d.exec('DELETE FROM rel_security');expect(witness(d)).toBe(0);
 });
 it('own revocation SQL rejects impersonated and cross-user actors then accepts self',()=>{const d=fresh();approve(d);d.exec("INSERT INTO sessions VALUES('imp','usr_a',4102444800000,'operator','email')");expect(d.prepare(ownRevokeSql).run('approval_a','imp').changes).toBe(0);expect(d.prepare(ownRevokeSql).run('approval_a','ses_a').changes).toBe(1);expect(witness(d)).toBe(0);});
 it('snapshot restore replays old authority, explicitly NOT rollback protection',()=>{const d=fresh();approve(d);const snapshot=d.serialize();d.exec("UPDATE users SET email='changed@example.test'");expect(witness(d)).toBe(0);const restored=new Database(snapshot);dbs.push(restored);expect(witness(restored)).toBe(1);});
 it('no live importer or migration registration exists',()=>{const walk=(dir:string):string[]=>readdirSync(dir).flatMap(n=>{const p=join(dir,n);return statSync(p).isDirectory()?walk(p):[p];});for(const p of walk('src'))expect(readFileSync(p,'utf8')).not.toMatch(/mnet-relationship-store|rel_security|rel_approvals|rel_witness/);});
 it('real competing SQLite writers serialize both approve/mutate orders, including first approval',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rel-race-'));try{for(const mutationFirst of [false,true,'both-approve']){
   const path=join(dir,`race-${mutationFirst}.db`);const d=fresh(path);d.exec('PRAGMA journal_mode=WAL;BEGIN IMMEDIATE');
   const mutation="UPDATE users SET email='changed@example.test'";
   if(mutationFirst===true)d.exec(mutation);else approve(d);
   const statements=mutationFirst?approvalBatch('ses_a','org_a','worker_approval','digest',true):[{sql:mutation,values:[]}];
   const worker=new Worker(`const{parentPort,workerData:w}=require('node:worker_threads');const D=require(w.module);const d=new D(w.path,{timeout:5000});parentPort.postMessage('attempting');try{d.transaction(()=>{for(const s of w.statements)d.prepare(s.sql).run(...s.values)})();parentPort.postMessage('done')}catch(e){parentPort.postMessage({error:e.message})}finally{d.close()}`,{eval:true,workerData:{path,module:createRequire(import.meta.url).resolve('better-sqlite3'),statements}});
   const done=new Promise<void>((resolve,reject)=>{worker.on('message',m=>{if(m==='attempting')setTimeout(()=>d.exec('COMMIT'),30);else if(m==='done')resolve();else reject(new Error(JSON.stringify(m)));});worker.on('error',reject);});await done;await worker.terminate();
   if(mutationFirst){expect(witness(d,'worker_approval')).toBe(1);if(mutationFirst==='both-approve'){expect(epoch(d)).toBe(0);expect(d.prepare('SELECT count(*) FROM rel_approvals').pluck().get()).toBe(2);}}else{expect(witness(d)).toBe(0);expect(status(d)).toBe('revoked');}
  }}finally{rmSync(dir,{recursive:true,force:true});}
 });
});
