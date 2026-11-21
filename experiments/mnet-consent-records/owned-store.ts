// Harness-only ownership factories. No arbitrary DB path/remote binding accepted.
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { openSqlite } from '../../src/server/db/node';
import { migrate } from '../../src/server/db';
export interface Stmt {sql:string;values?: (string|number)[]}
export interface OwnedStore {
 all<T extends Record<string,unknown>>(s:Stmt):Promise<T[]>;
 batch(s:Stmt[]):Promise<void>;
 close():Promise<void>;
 ownership:Readonly<{kind:'node-temp'|'local-d1';id:string;location:string}>;
 appDb?:ReturnType<typeof openSqlite>;
}
const owned=new WeakSet<OwnedStore>();
const version='consent-records-v1-session-bound-source-writes';
export async function ownedNode():Promise<OwnedStore> {
 const dir=mkdtempSync(join(tmpdir(),'consent-owned-')),id=randomUUID(),path=join(dir,'consent.sqlite');writeFileSync(join(dir,'owner'),id,{flag:'wx'});
 const db=openSqlite(path);await migrate(db);
 const client=(db as unknown as {$client:{prepare(q:string):{all(...v:unknown[]):Record<string,unknown>[];run(...v:unknown[]):unknown};transaction<T>(f:()=>T):()=>T;close():void}}).$client;
 const check=()=>{if(dirname(realpathSync(path))!==realpathSync(dir)||readFileSync(join(dir,'owner'),'utf8')!==id)throw new Error('ownership lost');};
 const store:OwnedStore={ownership:Object.freeze({kind:'node-temp',id,location:path}),appDb:db,
 async all<T extends Record<string,unknown>>(s:Stmt){check();return client.prepare(s.sql).all(...(s.values??[])) as T[];},
 async batch(statements){check();client.transaction(()=>{for(const s of statements)client.prepare(s.sql).run(...(s.values??[]));})();},
 async close(){client.close();rmSync(dir,{recursive:true,force:true});}};owned.add(store);return store;
}
export async function ownedLocalD1():Promise<OwnedStore>{
 const id=randomUUID(),name='owned-'+id;
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("unused")}}',compatibilityDate:'2026-08-01',d1Databases:{OWNED:name}}));
 const db=await mf.getD1Database('OWNED');
 const store:OwnedStore={ownership:Object.freeze({kind:'local-d1',id,location:name}),
 async all<T extends Record<string,unknown>>(s:Stmt){return (await db.prepare(s.sql).bind(...(s.values??[])).all()).results as T[];},
 async batch(statements){if(statements.length)await db.batch(statements.map(s=>db.prepare(s.sql).bind(...(s.values??[]))));},
 async close(){await mf.dispose();}};owned.add(store);return store;
}
export async function install(store:OwnedStore){
 if(!owned.has(store))throw new Error('not a harness-owned disposable database');
 const existing=await store.all({sql:"SELECT name FROM sqlite_master WHERE name GLOB 'rel_*'"});if(existing.length)throw new Error('no rel-object adoption');
 await store.batch(installationStatements());
 await verify(store);
}
// Exposed only to fault-test the exact atomic installation batch, not a remote installer.
export function installationStatements():Stmt[]{
 const original=readFileSync(new URL('../mnet-relationship-store/schema.sql',import.meta.url),'utf8');
 const lines=original.split('\n').filter(s=>s.trim()&&!s.startsWith('--')&&!s.startsWith('CREATE TABLE rel_witness'));
 const statements=lines.map(sql=>({sql:sql.startsWith('CREATE TABLE rel_approvals')?sql.replace('device_key_digest TEXT NOT NULL',"device_key_digest TEXT NOT NULL CHECK(length(device_key_digest)=64 AND device_key_digest NOT GLOB '*[^0-9a-f]*')"):sql}));
 return [...statements,{sql:"CREATE UNIQUE INDEX rel_approved_tuple ON rel_approvals(user_id,workspace_id,device_key_digest) WHERE status='approved'"},{sql:`CREATE TABLE rel_marker(version TEXT NOT NULL UNIQUE CHECK(version='${version}'))`},{sql:'INSERT INTO rel_marker VALUES(?)',values:[version]}];
}
export async function verify(store:OwnedStore){
 if(!owned.has(store))throw new Error('not harness owned');
 const rows=await store.all({sql:'SELECT version FROM rel_marker'});if(rows.length!==1||rows[0].version!==version)throw new Error('unknown consent schema marker');
 const witness=await store.all({sql:"SELECT name FROM sqlite_master WHERE name='rel_witness'"});if(witness.length)throw new Error('no witness consumer in consent composition');
}
