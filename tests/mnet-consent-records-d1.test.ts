import { describe, expect, it } from 'vitest';
import { ownedLocalD1, install, verify, installationStatements } from '../experiments/mnet-consent-records/owned-store';
import { sourceSchema, seedSql } from '../experiments/mnet-relationship-store/fixture';
import { insertSql, initializeSql, selectSql, revokeSql, APPROVED_CAP, HISTORY_CAP } from '../experiments/mnet-consent-records/sql';
describe('consent composition new SQL on harness-owned LOCAL D1 only',()=>{
 it('mechanical fresh binding ownership, atomic marker rollback, partial conflict and actor-scoped list/revoke',async()=>{
  const own=await ownedLocalD1();try{
   expect(own.ownership.kind).toBe('local-d1');expect(own.ownership.location).toBe('owned-'+own.ownership.id);
   await own.batch([...sourceSchema.split('\n'),...seedSql.split('\n')].filter(sql=>sql.trim()).map(sql=>({sql})));
   await expect(own.batch([...installationStatements(),{sql:'INSERT INTO absent VALUES(1)'}])).rejects.toThrow();expect(await own.all({sql:"SELECT name FROM sqlite_master WHERE name GLOB 'rel_*'"})).toEqual([]);
   await install(own);await verify(own);await expect(install(own)).rejects.toThrow('adoption');expect(await own.all({sql:"SELECT name FROM sqlite_master WHERE name='rel_witness'"})).toEqual([]);
   const approve=(id:string,digest='a'.repeat(64))=>own.batch([{sql:initializeSql,values:['ses_a']},{sql:insertSql,values:[id,digest,'ses_a','org_a',1]}]);
   await Promise.all([approve('a'),approve('b')]);const rows=await own.all({sql:selectSql,values:['ses_a']});expect(rows).toHaveLength(1);expect(rows[0].validity).toBe('currently-valid-session-bound-data');
   await own.batch([{sql:"INSERT INTO users VALUES('other','o@example.test',1,0)"},{sql:"INSERT INTO sessions VALUES('other_s','other',4102444800000,NULL,'email')"}]);expect(await own.all({sql:selectSql,values:['other_s']})).toEqual([]);
   await own.batch([{sql:revokeSql,values:[String(rows[0].id),'other_s']}]);expect((await own.all({sql:selectSql,values:['ses_a']}))[0].recordedStatus).toBe('approved');
   await own.batch([{sql:revokeSql,values:[String(rows[0].id),'ses_a']}]);expect((await own.all({sql:selectSql,values:['ses_a']}))[0].recordedStatus).toBe('revoked');await approve('fresh');expect(await own.all({sql:"SELECT id FROM rel_approvals WHERE status='approved'"})).toEqual([{id:'fresh'}]);
   await expect(approve('invalid','bad')).rejects.toThrow();
  }finally{await own.close();}
 },30000);
 it('actual concurrent distinct-digest batches cannot exceed approved/history caps',async()=>{
  const own=await ownedLocalD1();try{
   await own.batch([...sourceSchema.split('\n'),...seedSql.split('\n')].filter(sql=>sql.trim()).map(sql=>({sql})));await install(own);
   const approve=(i:number)=>own.batch([{sql:initializeSql,values:['ses_a']},{sql:insertSql,values:['record'+i,i.toString(16).padStart(64,'0'),'ses_a','org_a',1]}]);
   await Promise.all(Array.from({length:APPROVED_CAP+2},(_,i)=>approve(i)));
   expect((await own.all({sql:"SELECT count(*) n FROM rel_approvals WHERE status='approved'"}))[0].n).toBe(APPROVED_CAP);
   await own.batch([{sql:"UPDATE rel_approvals SET status='revoked' WHERE status='approved'"}]);
   await Promise.all(Array.from({length:HISTORY_CAP+2},(_,i)=>approve(i+10)));expect((await own.all({sql:'SELECT count(*) n FROM rel_approvals'}))[0].n).toBe(HISTORY_CAP);
   await own.batch([{sql:"UPDATE rel_approvals SET status='revoked' WHERE status='approved'"}]);await approve(99);expect((await own.all({sql:'SELECT count(*) n FROM rel_approvals'}))[0].n).toBe(HISTORY_CAP);
  }finally{await own.close();}
 },30000);
});
