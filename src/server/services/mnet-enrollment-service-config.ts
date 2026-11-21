import { z } from "zod";
import { parseMnetObject } from "./mnet-json";
import { enrollmentHandoffCore } from "./mnet-enrollment-handoff-shape";
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
export const serviceFixtureSchema = z.object({
 reserveMs: z.number().int().min(1000).max(120000), eventCapacity: z.number().int().min(3).max(8),
 serviceBudgets: z.object({ reserve: z.number().int().min(1).max(100), status: z.number().int().min(1).max(100), ack: z.number().int().min(1).max(100) }).strict(),
 requestsPerMinute: z.number().int().min(1).max(100),
 keys: z.array(z.object({ keyId: id, serviceId: id, active: z.boolean(), digest: enrollmentHandoffCore.shape.attemptId, registrarOrigin: z.string().url().max(2048), issuer: z.string().url().max(2048), audience: z.string().min(1).max(256) }).strict()).min(1).max(8),
}).strict().superRefine((p,c)=>{ if(new Set(p.keys.map(k=>k.keyId)).size!==p.keys.length || new Set(p.keys.map(k=>k.digest)).size!==p.keys.length || p.keys.some(k=>{try{const u=new URL(k.registrarOrigin);return u.protocol!=="https:" || u.origin!==k.registrarOrigin || !k.issuer.startsWith("https://") || /[?#\s\\]/.test(k.issuer);}catch{return true;}})) c.addIssue({code:"custom",message:"Invalid service scope"}); });
export type ServiceFixture = z.infer<typeof serviceFixtureSchema>;
export function serviceFixtureConfig(enabled:boolean,mode:string,raw?:string):ServiceFixture|undefined {
 if(!enabled)return undefined;
 if(mode!=="development"||!raw||raw.length>16384)throw new Error("Enrollment service requires explicit local fixture configuration");
 try{return serviceFixtureSchema.parse(parseMnetObject(raw));}catch{throw new Error("Invalid enrollment service fixture configuration");}
}
