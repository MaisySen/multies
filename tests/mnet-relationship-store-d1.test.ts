import { describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFileSync } from 'node:fs';
import { approvalBatch, witnessSql } from '../experiments/mnet-relationship-store/store';
import { sourceSchema, seedSql } from '../experiments/mnet-relationship-store/fixture';
import { witnessCases } from '../experiments/mnet-relationship-store/witness-cases';
const schema=readFileSync('experiments/mnet-relationship-store/schema.sql','utf8');
describe('actual local workerd D1 binding, no remote database',()=>{
 it('approved-status witness independently refuses each changed conditional boundary',async()=>{
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("unused")}}',compatibilityDate:'2026-08-01',d1Databases:Object.fromEntries(witnessCases.map((_,i)=>['DB'+i,'witness-'+i]))}));
  try{for(const [i,c] of witnessCases.entries()){
   const db=await mf.getD1Database('DB'+i);
   for(const sql of [...sourceSchema.split('\n'),...schema.split('\n'),...seedSql.split('\n')].filter(s=>s.trim()&&!s.trim().startsWith('--')))await db.prepare(sql).run();
   if(c.before)await db.prepare(c.before).run();
   await db.batch(approvalBatch('ses_a','org_a','a','digest',true).map(s=>db.prepare(s.sql).bind(...s.values)));
   expect((await db.prepare(witnessSql).bind('before','a').run()).meta.changes,c.name).toBe(1);
   for(const sql of c.mutation.split(';').filter(s=>s.trim()))await db.prepare(sql).run();
   expect(await db.prepare("SELECT status FROM rel_approvals WHERE id='a'").first('status'),c.name).toBe('approved');
   expect((await db.prepare(witnessSql).bind('after','a').run()).meta.changes,c.name).toBe(0);
  }}finally{await mf.dispose();}
 },30000);

 it('runs source triggers, conditional consumption, atomic first approval and error rollback',async()=>{
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("unused")}}',compatibilityDate:'2026-08-01',d1Databases:['DB']}));
  try{
   const db=await mf.getD1Database('DB');
   const statements=[...sourceSchema.split('\n'),...schema.split('\n'),...seedSql.split('\n')].filter(s=>s.trim()&&!s.trim().startsWith('--'));
   for(const sql of statements)await db.prepare(sql).run();
   const approve=(id:string)=>db.batch(approvalBatch('ses_a','org_a',id,'digest',true).map(s=>db.prepare(s.sql).bind(...s.values)));
   await expect(db.batch([...approvalBatch('ses_a','org_a','bad','digest',true).map(s=>db.prepare(s.sql).bind(...s.values)),db.prepare('INSERT INTO absent VALUES(1)')])).rejects.toThrow();
   expect(await db.prepare('SELECT count(*) n FROM rel_security').first('n')).toBe(0);
   await approve('a');expect((await db.prepare(witnessSql).bind('before','a').run()).meta.changes).toBe(1);
   await db.prepare("INSERT INTO sessions VALUES('old','usr_a',1,NULL,'email')").run();await db.prepare("DELETE FROM sessions WHERE id='old'").run();expect(await db.prepare('SELECT generation FROM rel_security').first('generation')).toBe(0);
   await db.prepare("INSERT INTO accounts VALUES('acc','usr_a','credential','password-hash')").run();expect(await db.prepare('SELECT status FROM rel_approvals').first('status')).toBe('revoked');expect((await db.prepare(witnessSql).bind('after','a').run()).meta.changes).toBe(0);
   await approve('b');await db.prepare("CREATE TRIGGER injected_abort AFTER UPDATE ON rel_security BEGIN SELECT RAISE(ABORT,'injected'); END").run();
   await expect(db.prepare("UPDATE users SET email='other@example.test'").run()).rejects.toThrow();expect(await db.prepare('SELECT email FROM users').first('email')).toBe('a@example.test');expect(await db.prepare("SELECT status FROM rel_approvals WHERE id='b'").first('status')).toBe('approved');
   await db.prepare('DROP TRIGGER injected_abort').run();await db.prepare('DELETE FROM users').run();expect(await db.prepare("SELECT status FROM rel_approvals WHERE id='b'").first('status')).toBe('revoked');
  }finally{await mf.dispose();}
 },30000);
});
