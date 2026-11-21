import {it,expect} from "vitest";
import {reserveDescriptor} from "@/server/services/mnet-enrollment-reserve";
const t=(n:number)=>btoa(String.fromCharCode(...new Uint8Array(32).fill(n))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
it("matches independent Python SHA256 over the fixed570byte ordered descriptor vector",async()=>{
 const p={ticket:t(8),handoffId:t(1),reserveId:t(2),launch:{version:1 as const,purpose:"mnet-enrollment" as const,attemptId:t(3),devicePublicKey:t(4),credentialDigest:t(5),challenge:t(6),state:t(7),redirectUri:"http://127.0.0.1:34567/mnet/enrollment/callback",platform:"linux" as const},binding:{workspaceId:"fixture-workspace",issuer:"https://issuer.test/path",registrarOrigin:"https://registrar.test",audience:"fixture-audience",mappingRevision:"fixture-r1",networkId:"fixture-network"}};
 expect(await reserveDescriptor(p,"fixture-service")).toBe("PpyCC3vuVGtoWky2_sra1kJHEJEolMs9tIrwCu7v4hA");
 expect(await reserveDescriptor({...p,ticket:t(9)},"fixture-service")).toBe(await reserveDescriptor(p,"fixture-service"));
 expect(await reserveDescriptor({...p,reserveId:t(9)},"fixture-service")).not.toBe(await reserveDescriptor(p,"fixture-service"));
 expect(await reserveDescriptor(p,"different-service")).not.toBe(await reserveDescriptor(p,"fixture-service"));
});
