/**
 * Where large message parts live. Small attachments stay in the database (base64), as before;
 * with an S3 compatible bucket configured (BODY_STORE_*), parts over the inline limit go to the
 * bucket instead of being dropped. Any S3 API works: AWS S3 in Sydney (ap-southeast-2),
 * Cloudflare R2, Backblaze B2 or MinIO on your own server. Requests are signed with aws4fetch.
 */
import { AwsClient } from "aws4fetch";
import type { Deps } from "../../context";

export interface BodyStore {
  readonly name: string;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

export interface S3Config { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string }

export class S3BodyStore implements BodyStore {
  readonly name = "s3";
  private aws: AwsClient;
  constructor(private c: S3Config, private fetchImpl: typeof fetch = fetch) {
    this.aws = new AwsClient({ accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, region: c.region, service: "s3" });
  }
  private url(key: string) {
    return `${this.c.endpoint.replace(/\/$/, "")}/${encodeURIComponent(this.c.bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }
  private async send(key: string, init: RequestInit) {
    return this.fetchImpl(await this.aws.sign(this.url(key), init));
  }
  async put(key: string, bytes: Uint8Array, contentType: string) {
    const res = await this.send(key, { method: "PUT", body: bytes as BodyInit, headers: { "content-type": contentType } });
    if (!res.ok) throw new Error(`Body store refused the upload (${res.status})`);
  }
  async get(key: string) {
    const res = await this.send(key, { method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Body store read failed (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }
  async delete(key: string) {
    const res = await this.send(key, { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new Error(`Body store delete failed (${res.status})`);
  }
}

/** The configured store, or undefined to keep everything in the database. */
export function bodyStoreFor(deps: Pick<Deps, "config" | "fetch">): BodyStore | undefined {
  const c = deps.config.bodyStore;
  return c ? new S3BodyStore(c, deps.fetch) : undefined;
}

export const attachmentKey = (orgId: string, attachmentId: string) => `attachments/${orgId}/${attachmentId}`;
