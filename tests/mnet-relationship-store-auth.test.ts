import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { makeTestApp, Client } from './helpers';
import { authFor } from '@/server/auth';
import { approvalBatch, witnessSql } from '../experiments/mnet-relationship-store/store';
const schema=readFileSync('experiments/mnet-relationship-store/schema.sql','utf8');
async function setup(removePassword=false) {
 const ctx=await makeTestApp();const c=new Client(ctx.app);await c.signup('store-auth@example.test');
 const db=(ctx.db as unknown as {$client:Database.Database}).$client;
 db.exec('UPDATE users SET email_verified=1');
 if(removePassword)db.exec("DELETE FROM accounts WHERE provider_id='credential'");
 db.exec(schema);
 const row=db.prepare('SELECT s.id session,m.organization_id org,s.user_id user FROM sessions s JOIN members m ON m.user_id=s.user_id LIMIT 1').get() as {session:string;org:string;user:string};
 db.transaction(()=>{for(const s of approvalBatch(row.session,row.org,'approval','digest',true))db.prepare(s.sql).run(...s.values)})();
 const epoch=()=>db.prepare('SELECT generation FROM rel_security').pluck().get() as number;
 const witness=()=>db.prepare(witnessSql).run('w','approval').changes;
 expect(epoch()).toBe(0);return {ctx,c,db,row,epoch,witness};
}
describe('actual installed auth mutation integration, disposable store only',()=>{
 for(const revokeOtherSessions of [false,true])it(`password change flag=${revokeOtherSessions} fences, source-session survival is conditional`,async()=>{
  const {c,db,row,epoch,witness}=await setup();try{
   const r=await c.post('/api/auth/change-password',{currentPassword:'a-strong-password',newPassword:'a-new-strong-password',revokeOtherSessions});expect(r.status).toBe(200);expect(epoch()).toBeGreaterThan(0);expect(witness()).toBe(0);
   const remaining=db.prepare('SELECT count(*) FROM sessions WHERE id=?').pluck().get(row.session);expect(remaining).toBe(revokeOtherSessions?0:1);
  }finally{db.close();}
 });
 it('server-only setPassword fences actual credential INSERT; no session deletion is claimed',async()=>{
  const {ctx,c,db,row,epoch,witness}=await setup(true);try{
   await authFor(ctx.deps).api.setPassword({headers:new Headers({host:'localhost',cookie:c.cookie}),body:{newPassword:'a-new-strong-password'}});
   expect(epoch()).toBeGreaterThan(0);expect(witness()).toBe(0);expect(db.prepare('SELECT count(*) FROM sessions WHERE id=?').pluck().get(row.session)).toBe(1);
  }finally{db.close();}
 });
 it('revoke-other no-op is not detectable by source triggers, actual other-session deletion fences',async()=>{
  const {c,ctx,db,epoch,witness}=await setup();try{
   expect((await c.post('/api/auth/revoke-other-sessions',{})).status).toBe(200);expect(epoch()).toBe(0);
   const other=new Client(ctx.app);expect((await other.login('store-auth@example.test')).status).toBe(200);
   expect((await c.post('/api/auth/revoke-other-sessions',{})).status).toBe(200);expect(epoch()).toBeGreaterThan(0);expect(witness()).toBe(0);
  }finally{db.close();}
 });
 it('all-session revoke deletes original session and fences',async()=>{
  const {c,db,row,epoch,witness}=await setup();try{expect((await c.post('/api/auth/revoke-sessions',{})).status).toBe(200);expect(epoch()).toBeGreaterThan(0);expect(witness()).toBe(0);expect(db.prepare('SELECT count(*) FROM sessions WHERE id=?').pluck().get(row.session)).toBe(0);}finally{db.close();}
 });
 it('reset uses verified reset subject, deletes sessions and changes password',async()=>{
  const {ctx,db,epoch,witness}=await setup();try{
   const anon=new Client(ctx.app);expect((await anon.post('/api/auth/request-password-reset',{email:'store-auth@example.test',redirectTo:'/reset-password'})).status).toBe(200);
   const v=db.prepare("SELECT identifier FROM verifications WHERE identifier LIKE 'reset-password:%'").get() as {identifier:string};
   expect((await anon.post('/api/auth/reset-password',{token:v.identifier.slice('reset-password:'.length),newPassword:'a-new-strong-password'})).status).toBe(200);expect(epoch()).toBeGreaterThan(0);expect(witness()).toBe(0);expect(db.prepare('SELECT count(*) FROM sessions').pluck().get()).toBe(0);
  }finally{db.close();}
 });
 it('actual SSO changes and two-step ownership transfer invalidate without changing legacy session',async()=>{
  const {ctx,c,db,row,witness}=await setup();try{
   const other=new Client(ctx.app);await other.signup('target-store@example.test');const target=db.prepare("SELECT id FROM users WHERE email='target-store@example.test'").pluck().get() as string;
   db.prepare("INSERT INTO members(id,user_id,organization_id,role,kind,created_at) VALUES('target_member',?,?,'member','human',?)").run(target,row.org,Date.now());
   const r=await c.post('/api/team/transfer',{userId:target,password:'a-strong-password'});expect(r.status).toBe(200);expect(witness()).toBe(0);expect(db.prepare('SELECT count(*) FROM sessions WHERE id=?').pluck().get(row.session)).toBe(1);
  }finally{db.close();}
  const s=await setup();try{
   (s.ctx.deps.config.auth.social as Record<string,unknown>).google={clientId:'g',clientSecret:'s'};
   expect((await s.c.put('/api/org/sso',{required:true})).status).toBe(200);expect((await s.c.put('/api/org/sso',{required:false})).status).toBe(200);expect(s.witness()).toBe(0);
  }finally{s.db.close();}
 });
 it('failed password and disabled email-change do not invent source security events',async()=>{
  const {c,db,epoch,witness}=await setup();try{
   expect((await c.post('/api/auth/change-password',{currentPassword:'wrong-password',newPassword:'a-new-strong-password'})).status).toBe(400);
   const r=await c.post('/api/auth/change-email',{newEmail:'new@example.test'});expect(r.status).toBe(400);expect(epoch()).toBe(0);expect(witness()).toBe(1);
  }finally{db.close();}
 });
});
