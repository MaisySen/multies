// Separate harness composition ONLY. No normal app imports this module.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Deps } from '../../src/server/context';
import { csrfGuard } from '../../src/server/middleware';
import { rateLimit } from '../../src/server/lib/rate-limit';
import { HttpError } from '../../src/server/lib/errors';
import { mnetPerson } from '../../src/server/services/mnet';
import { body } from '../../src/server/routes/mnet';
import { randomToken } from '../../src/server/lib/crypto';
import { verify, type OwnedStore } from './owned-store';
import { actorSql, initializeSql, insertSql, revokeSql, selectSql } from './sql';
export const consentContract=Object.freeze({networkingEnabled:false,authorityGranted:false,mode:'recorded-consent-session-bound-data',securityPolicy:'source-write-only',activeSessionDeletePolicy:'any-active-session-deletion-invalidates-all-own-records',noOpSecurityIntentCovered:false});
const request=z.object({workspaceId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),deviceDigest:z.string().regex(/^[0-9a-f]{64}$/),explicit:z.literal(true)}).strict();
interface Row extends Record<string,unknown>{id:string;recordedStatus:string;validity:string}
export async function consentApp(deps:Deps,store:OwnedStore){
 await verify(store);
 if(store.appDb!==deps.db)throw new Error('auth database and owned consent store must be identical');
 const app=new Hono<AppEnv>();
 app.use('*',async(c,next)=>{c.set('deps',deps);c.set('ip',c.req.header('cf-connecting-ip')??'unknown');c.set('log',deps.log!);c.header('Cache-Control','no-store');c.header('Referrer-Policy','no-referrer');await next();});
 app.use('/api/*',csrfGuard);
 app.use('/api/*',rateLimit('handoff',c=>`consent:${c.var.ip}`,{countReads:true}));
 const session=async(headers:Headers)=>{const s=await mnetPerson(deps,headers);if(!(await store.all({sql:actorSql,values:[s.id,s.userId]})).length)throw new HttpError(401,'consent_sign_in','Sign in to view consent records.');return s;};
 const listOwn=async(id:string,where:string,values:(string|number)[])=>store.all<Row>({sql:selectSql+where,values:[id,...values]});
 app.post('/api/consents',async c=>{
  const input=await body(c,request),s=await session(c.req.raw.headers),id=randomToken();
  await store.batch([{sql:initializeSql,values:[s.id]},{sql:insertSql,values:[id,input.deviceDigest,s.id,input.workspaceId,1]}]);
  // Readback status is at THIS statement, not a durable promise it remains approved.
  const rows=await listOwn(s.id," AND a.workspace_id=? AND a.device_key_digest=? ORDER BY (a.id=?) DESC,(a.status='approved') DESC,a.id DESC LIMIT 1",[input.workspaceId,input.deviceDigest,id]);
  const row=rows.find(r=>r.id===id)||rows.find(r=>r.recordedStatus==='approved');
  // If raced revoke removed the approved tuple, don't claim still-recorded success.
  if(!row){if(!(await store.all({sql:actorSql,values:[s.id,s.userId]})).length)throw new HttpError(401,'consent_sign_in','Sign in again.');throw new HttpError(409,'consent_not_recorded','No new consent recorded. Eligibility, storage cap or concurrent change prevented it.');}
  return c.json({...consentContract,result:row.id===id?'inserted-at-read':'already-recorded-at-read',statusAtRead:true,record:row});
 });
 app.get('/api/consents',async c=>{
  const q=c.req.query();if(Object.keys(q).some(k=>k!=='before')||Object.keys(q).some(k=>c.req.queries(k)!.length!==1)||(q.before!==undefined&&!/^[A-Za-z0-9_-]{43}$/.test(q.before)))throw new HttpError(400,'invalid_request','Invalid list cursor.');
  const s=await session(c.req.raw.headers),rows=await listOwn(s.id,q.before?' AND a.id<? ORDER BY a.id DESC LIMIT 5':' ORDER BY a.id DESC LIMIT 5',q.before?[q.before]:[]);
  // Empty result could be raced session deletion. Recheck only to deny, never to grant.
  if(!(await store.all({sql:actorSql,values:[s.id,s.userId]})).length)throw new HttpError(401,'consent_sign_in','Sign in again.');
  const records=rows.slice(0,4);return c.json({...consentContract,statusAtRead:true,records,next:rows.length>4?records.at(-1)!.id:null});
 });
 app.delete('/api/consents/:id',async c=>{
  const id=c.req.param('id');if(!/^[A-Za-z0-9_-]{43}$/.test(id))throw new HttpError(403,'consent_denied','Consent unavailable.');
  const s=await session(c.req.raw.headers);await store.batch([{sql:revokeSql,values:[id,s.id]}]);
  const row=(await listOwn(s.id,' AND a.id=?',[id]))[0];if(!row)throw new HttpError(403,'consent_denied','Consent unavailable.');
  return c.json({...consentContract,statusAtRead:true,record:row});
 });
 app.onError((err,c)=>err instanceof HttpError?c.json({error:{code:err.code,message:err.message}},err.status):c.json({error:{code:'unavailable',message:'Consent data unavailable.'}},503));
 return app;
}
