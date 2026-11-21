import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { makeTestApp, Client } from './helpers';
import { createApp } from '@/server/app';
import { users } from '@/server/db/schema';
import { ownedNode, install, verify, type OwnedStore } from '../experiments/mnet-consent-records/owned-store';
import { DB_NOW_MS, insertSql, selectSql, APPROVED_CAP, HISTORY_CAP } from '../experiments/mnet-consent-records/sql';
const resources:OwnedStore[]=[];
afterEach(async()=>{for(const r of resources.splice(0))await r.close();});
async function setup(){
 const own=await ownedNode();resources.push(own);const base=await makeTestApp();const deps={...base.deps,db:own.appDb!};const normal=createApp(deps),c=new Client(normal);await c.signup('consent-owner@example.test');
 await deps.db.update(users).set({emailVerified:true}).where(eq(users.email,'consent-owner@example.test'));
 const rows=await own.all({sql:'SELECT s.id sid,s.user_id uid,m.organization_id org FROM sessions s JOIN members m ON m.user_id=s.user_id LIMIT 1'});const row=rows[0] as {sid:string;uid:string;org:string};
 const master={sql:"SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name"};const beforeImport=await own.all(master);const {consentApp}=await import('../experiments/mnet-consent-records/app');expect(await own.all(master)).toEqual(beforeImport);
 await install(own);const app=await consentApp(deps,own);
 const raw=async(method:string,path='/api/consents',value?:unknown,headers:Record<string,string>={})=>{const r=await app.request(path,{method,headers:{host:'localhost',cookie:c.cookie,'content-type':'application/json',...headers},...(value===undefined?{}:{body:typeof value==='string'?value:JSON.stringify(value)})});return {status:r.status,body:await r.json() as Record<string,any>,headers:r.headers};}; // eslint-disable-line @typescript-eslint/no-explicit-any
 const approve=(digest='a'.repeat(64))=>raw('POST','/api/consents',{workspaceId:row.org,deviceDigest:digest,explicit:true});
 return {own,deps,normal,c,row,app,raw,approve};
}
describe('isolated authenticated consent DATA composition',()=>{
 it('real cookie approve/list/revoke is own-user DATA only, duplicate retains provenance',async()=>{
  const s=await setup(),a=await s.approve();expect(a.status).toBe(200);expect(a.body).toMatchObject({networkingEnabled:false,authorityGranted:false,result:'inserted-at-read',statusAtRead:true});expect(a.body.record.validity).toBe('currently-valid-session-bound-data');
  const stored=await s.own.all({sql:'SELECT * FROM rel_approvals'});const duplicate=await s.approve();expect(duplicate.body.result).toBe('already-recorded-at-read');expect(await s.own.all({sql:'SELECT * FROM rel_approvals'})).toEqual(stored);
  const list=await s.raw('GET');expect(list.body.records).toHaveLength(1);expect(list.headers.get('cache-control')).toBe('no-store');expect(JSON.stringify(list.body)).not.toMatch(/approved_security_generation|credential|token|device_key_digest|session_id/);
  const revoke=await s.raw('DELETE','/api/consents/'+a.body.record.id);expect(revoke.body.record.recordedStatus).toBe('revoked');expect((await s.raw('DELETE','/api/consents/'+a.body.record.id)).status).toBe(200);
  const again=await s.approve();expect(again.body.record.id).not.toBe(a.body.record.id);expect(again.body.result).toBe('inserted-at-read');
 });
 it('mounts real CSRF and strict bounded parser; GET has no consent mutation',async()=>{
  const s=await setup(),value={workspaceId:s.row.org,deviceDigest:'a'.repeat(64),explicit:true};
  for(const headers of [{origin:'https://evil.example'},{'sec-fetch-site':'cross-site'}]){const r=await s.raw('POST','/api/consents',value,headers);expect(r.status).toBe(403);expect(r.body.error.code).toBe('bad_origin');}
  expect((await s.raw('POST','/api/consents',value,{origin:'http://localhost'})).status).toBe(200);
  for(const body of [{...value,userId:s.row.uid},{...value,deviceDigest:'A'.repeat(64)},{...value,explicit:false},'{"explicit":true,"explicit":false}', 'x'.repeat(8200)])expect((await s.raw('POST','/api/consents',body)).status).toBe(400);
  const before=await s.own.all({sql:'SELECT * FROM rel_approvals'});await s.raw('GET');await s.raw('GET','/api/consents?before=invalid');expect(await s.own.all({sql:'SELECT * FROM rel_approvals'})).toEqual(before);
  await expect(s.own.batch([{sql:"UPDATE rel_approvals SET device_key_digest='bad'"}])).rejects.toThrow();
 });
 it('rig-wide rate limit cannot be evaded with rotating untrusted IP headers',async()=>{const s=await setup();for(let i=0;i<20;i++)expect((await s.raw('GET','/api/consents',undefined,{'cf-connecting-ip':`203.0.113.${i}`,'x-real-ip':`192.0.2.${i}`,'x-forwarded-for':`198.51.100.${i}`})).status).toBe(200);expect((await s.raw('GET','/api/consents',undefined,{'cf-connecting-ip':'127.0.0.1','x-real-ip':'new','x-forwarded-for':'different'})).status).toBe(429);});
 it('foreign/missing revoke indistinguishable; membership loss still lists and revokes',async()=>{
  const s=await setup(),a=await s.approve(),other=new Client(s.normal);await other.signup('other-consent@example.test');
  const r=await s.raw('DELETE','/api/consents/'+a.body.record.id,undefined,{cookie:other.cookie}),missing=await s.raw('DELETE','/api/consents/'+'x'.repeat(43),undefined,{cookie:other.cookie});expect(r.status).toBe(403);expect(r.body).toEqual(missing.body);
  await s.own.batch([{sql:'DELETE FROM members WHERE user_id=?',values:[s.row.uid]}]);expect((await s.raw('GET')).body.records).toHaveLength(1);expect((await s.raw('DELETE','/api/consents/'+a.body.record.id)).status).toBe(200);
 });
 it('real resolver refuses absent/impersonated/expired cookies, body IDs never authenticate',async()=>{
  const s=await setup();expect((await s.raw('GET','/api/consents',undefined,{cookie:''})).status).toBe(401);
  await s.own.batch([{sql:"UPDATE sessions SET impersonated_by='operator' WHERE id=?",values:[s.row.sid]}]);expect((await s.approve()).status).toBe(403);
  await s.own.batch([{sql:'UPDATE sessions SET impersonated_by=NULL,expires_at=1 WHERE id=?',values:[s.row.sid]}]);expect((await s.raw('GET')).status).toBe(401);
 });
 it('ineffective approved record blocks reapprove until revoke, using current new session',async()=>{
  const s=await setup(),a=await s.approve();await s.c.login('consent-owner@example.test');
  await s.own.batch([{sql:'DROP TRIGGER rel_session_update'},{sql:'UPDATE sessions SET expires_at=1 WHERE id=?',values:[s.row.sid]}]);
  const list=await s.raw('GET');expect(list.body.records[0]).toMatchObject({recordedStatus:'approved',validity:'original-session-ended'});
  const d=await s.approve();expect(d.body.result).toBe('already-recorded-at-read');expect(d.body.record.validity).toBe('original-session-ended');expect(d.body.record.id).toBe(a.body.record.id);
  await s.raw('DELETE','/api/consents/'+a.body.record.id);expect((await s.approve()).body.record.validity).toBe('currently-valid-session-bound-data');
 });
 it('DB clock wins effective equality, app clock can deny but never extend DB validity',async()=>{
  const s=await setup();await s.approve();s.deps.now=()=>new Date(0);await s.own.batch([{sql:'DROP TRIGGER rel_session_update'},{sql:`UPDATE sessions SET expires_at=${DB_NOW_MS} WHERE id=?`,values:[s.row.sid]}]);
  // A permissive app clock never overrides DB-expired actor facts.
  const rows=await s.own.all({sql:selectSql,values:[s.row.sid]});expect(rows).toHaveLength(0);expect((await s.raw('GET')).status).toBe(401);
 });
 it('effective original-session equality is denied within one DB-time statement, list pagination is bounded',async()=>{
  const s=await setup();await s.approve();await s.c.login('consent-owner@example.test');const actor=(await s.own.all({sql:'SELECT id FROM sessions WHERE id<>?',values:[s.row.sid]}))[0].id;
  const exact=await s.own.all({sql:`WITH sessions AS (SELECT id,user_id,impersonated_by,login_method,CASE WHEN id=? THEN ${DB_NOW_MS} ELSE expires_at END expires_at FROM main.sessions) `+selectSql,values:[s.row.sid,String(actor)]});expect(exact[0].validity).toBe('original-session-ended');
  s.deps.now=()=>new Date('2099-01-01T00:00:00Z');expect((await s.raw('GET')).status).toBe(403);s.deps.now=()=>new Date();
  for(let i=0;i<4;i++){const a=await s.approve((i+1).toString(16).repeat(64));if(a.status===200)await s.raw('DELETE','/api/consents/'+a.body.record.id);}
  const first=await s.raw('GET');expect(first.body.records).toHaveLength(4);expect(first.body.next).toMatch(/^[A-Za-z0-9_-]{43}$/);const next=await s.raw('GET','/api/consents?before='+first.body.next);expect(next.body.records).toHaveLength(1);expect(first.body.records.map((r:{id:string})=>r.id)).not.toContain(next.body.records[0].id);
 });
 it('no-op other-session intent does not fence; expired cleanup not global; active-session delete is global',async()=>{
  const s=await setup();await s.approve();await s.approve('b'.repeat(64));expect((await s.c.post('/api/auth/revoke-other-sessions',{})).status).toBe(200);expect((await s.raw('GET')).body.records.every((r:{recordedStatus:string})=>r.recordedStatus==='approved')).toBe(true);
  await s.own.batch([{sql:"INSERT INTO sessions(id,token,user_id,expires_at,created_at,updated_at) VALUES('old','old',?,1,1,1)",values:[s.row.uid]},{sql:"DELETE FROM sessions WHERE id='old'"}]);expect((await s.raw('GET')).body.records[0].recordedStatus).toBe('approved');
  const other=new Client(s.normal);await other.login('consent-owner@example.test');const rows=await s.own.all({sql:'SELECT id FROM sessions WHERE id<>?',values:[s.row.sid]});await s.own.batch([{sql:'DELETE FROM sessions WHERE id=?',values:[String(rows[0].id)]}]);expect((await s.raw('GET')).body.records.every((r:{recordedStatus:string})=>r.recordedStatus==='revoked')).toBe(true);
 });
 it('atomic caps bound approved and history, partial unique conflict path readbacks status',async()=>{
  const s=await setup();for(let i=0;i<APPROVED_CAP;i++)expect((await s.approve(i.toString(16).repeat(64))).status).toBe(200);
  expect((await s.approve('f'.repeat(64))).status).toBe(409);const listed=await s.raw('GET');expect(listed.body.records).toHaveLength(4);
  for(const row of await s.own.all({sql:'SELECT id FROM rel_approvals'}))await s.raw('DELETE','/api/consents/'+row.id);
  for(let i=0;i<HISTORY_CAP-APPROVED_CAP;i++){const a=await s.approve((i+4).toString(16).repeat(64));expect(a.status).toBe(200);await s.raw('DELETE','/api/consents/'+a.body.record.id);}
  // Use SQL to avoid the explicitly tested request rate limit masking the storage boundary.
  await s.own.batch([{sql:insertSql,values:['last','e'.repeat(64),s.row.sid,s.row.org,1]}]);expect((await s.own.all({sql:'SELECT count(*) n FROM rel_approvals'}))[0].n).toBe(HISTORY_CAP);
 });
 it('concurrent duplicate approval has one winner; revoke/read orders are explicitly momentary',async()=>{
  const s=await setup(),results=await Promise.all([s.approve(),s.approve()]);expect(results.map(r=>r.body.result).sort()).toEqual(['already-recorded-at-read','inserted-at-read']);
  const a=results[0].body.record;const before=await s.approve();expect(before.body.record.recordedStatus).toBe('approved');await s.raw('DELETE','/api/consents/'+a.id);expect((await s.raw('GET')).body.records[0].recordedStatus).toBe('revoked');
  const after=await s.approve();expect(after.body.result).toBe('inserted-at-read');expect(after.body.record.id).not.toBe(a.id);
 });
 it('committed revoke between approve and readback is reported as status-at-read, not lasting consent',async()=>{
  for(const duplicate of [false,true]){
   const s=await setup();const existing=duplicate?await s.approve():null;
   const realBatch=s.own.batch.bind(s.own);let release!:()=>void,arrived!:()=>void;const ready=new Promise<void>(r=>{arrived=r;}),resume=new Promise<void>(r=>{release=r;});let once=true;
   s.own.batch=async statements=>{await realBatch(statements);if(once&&statements.some(q=>q.sql===insertSql)){once=false;arrived();await resume;}};
   const pending=s.approve();await ready;
   const id=existing?.body.record.id??String((await s.own.all({sql:'SELECT id FROM rel_approvals'}))[0].id);
   expect((await s.raw('DELETE','/api/consents/'+id)).body.record.recordedStatus).toBe('revoked');release();const result=await pending;s.own.batch=realBatch;
   if(duplicate){expect(result.status).toBe(409);expect(result.body.error.code).toBe('consent_not_recorded');}else{expect(result.body.result).toBe('inserted-at-read');expect(result.body.record.recordedStatus).toBe('revoked');expect(result.body.statusAtRead).toBe(true);}
  }
 });
 it('403 readback can follow committed revoke when actor is lost before response',async()=>{
  const s=await setup(),a=await s.approve(),realBatch=s.own.batch.bind(s.own);let once=true;
  s.own.batch=async statements=>{await realBatch(statements);if(once&&statements.some(q=>q.sql.startsWith("UPDATE rel_approvals SET status='revoked'"))){once=false;await realBatch([{sql:'DELETE FROM sessions WHERE id=?',values:[s.row.sid]}]);}};
  const result=await s.raw('DELETE','/api/consents/'+a.body.record.id);expect(result.status).toBe(403);expect((await s.own.all({sql:'SELECT status FROM rel_approvals WHERE id=?',values:[a.body.record.id]}))[0].status).toBe('revoked');s.own.batch=realBatch;
 });
 it('atomic marker install fails without residual rel objects; unknown version and app/store mismatch refuse',async()=>{
  const own=await ownedNode();resources.push(own);const {installationStatements}=await import('../experiments/mnet-consent-records/owned-store');
  await expect(own.batch([...installationStatements(),{sql:'INSERT INTO absent VALUES(1)'}])).rejects.toThrow();expect(await own.all({sql:"SELECT name FROM sqlite_master WHERE name GLOB 'rel_*'"})).toEqual([]);
  await install(own);await own.batch([{sql:'DROP TABLE rel_marker'},{sql:'CREATE TABLE rel_marker(version TEXT)'},{sql:"INSERT INTO rel_marker VALUES('unknown')"}]);await expect(verify(own)).rejects.toThrow('unknown');
  const s=await setup(),other=await ownedNode();resources.push(other);await install(other);const {consentApp}=await import('../experiments/mnet-consent-records/app');await expect(consentApp(s.deps,other)).rejects.toThrow('identical');
 });
 it('normal app schema/imports unchanged; installer refuses adoption and atomic marker unknowns',async()=>{
  const own=await ownedNode();resources.push(own);const master=()=>own.all({sql:"SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name"});const before=await master();await import('../experiments/mnet-consent-records/app');expect(await master()).toEqual(before);await expect(verify(own)).rejects.toThrow();
  await own.batch([{sql:'CREATE TABLE rel_unknown(id TEXT)'}]);await expect(install(own)).rejects.toThrow('adoption');
  const s=await setup();expect((await s.normal.request('/api/consents',{headers:{host:'localhost',cookie:s.c.cookie}})).status).toBe(404);await expect(install(s.own)).rejects.toThrow('adoption');
  const walk=(dir:string):string[]=>readdirSync(dir).flatMap(n=>{const p=join(dir,n);return statSync(p).isDirectory()?walk(p):[p];});for(const p of walk('src'))expect(readFileSync(p,'utf8')).not.toMatch(/mnet-consent-records|rel_approvals|rel_marker/);
  await expect(install({...own})).rejects.toThrow('harness-owned');
 });
 it('installer rejects lost physical ownership sentinel',async()=>{const own=await ownedNode();resources.push(own);writeFileSync(join(dirname(own.ownership.location),'owner'),'not-owner');await expect(install(own)).rejects.toThrow('ownership lost');});
});
