import { lstat, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

export interface FixtureIssuance {
 workspaceId: string;
 deviceKey: string;
 principalId: string;
 exchangeStartedAtMS: number;
 credentialExpiresAtMS: number;
}
// Test-only, opt-in, one disposable artifact. This helper never receives or
// serializes a bearer. The caller checks the wire does not contain its token.
export async function exportOwnAccountWire(wire: Uint8Array, issuance: FixtureIssuance): Promise<void> {
 const dir = process.env.MNET_OWN_ACCOUNT_FIXTURE_DIR;
 if (!dir) return;
 if (!path.isAbsolute(dir) || path.resolve(dir) !== dir || await realpath(dir) !== dir) throw new Error("Fixture directory must be explicit and real");
 const info = await lstat(dir);
 if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new Error("Fixture directory must be private");
 if (wire.byteLength < 1 || wire.byteLength > 8192) throw new Error("Fixture wire exceeds bound");
 const retained = {workspaceId:issuance.workspaceId,deviceKey:issuance.deviceKey,principalId:issuance.principalId,exchangeStartedAtMS:issuance.exchangeStartedAtMS,credentialExpiresAtMS:issuance.credentialExpiresAtMS};
 const envelope = Buffer.from(JSON.stringify({version:1,purpose:"mnet-own-account-source-fixture-v1",wireBase64:Buffer.from(wire).toString("base64"),issuance:retained}),"utf8");
 if (envelope.byteLength > 16384) throw new Error("Fixture envelope exceeds bound");
 await writeFile(path.join(dir,"own-account-source.json"),envelope,{flag:"wx",mode:0o600});
}
