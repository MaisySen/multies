/**
 * Talks to the private document engine. Every call is signed with HMAC SHA256 (Web Crypto) over
 * the method, path with query, time, a random nonce, workspace, user, byte cap and content length; the engine
 * refuses anything unsigned, stale or replayed. Uploads are streamed through unread: the Worker
 * never buffers or hashes a file (CPU budget), TLS protects the body and the signature binds its length.
 * The shared vector in tests/fixtures/tools-signing-vector.json is checked here and in the engine.
 */
import { toHex } from "../../lib/crypto";

export interface EngineConfig { url: string; keyId: string; key: string }

export interface EngineCall {
  method: "GET" | "POST" | "DELETE";
  /** Path with query, e.g. /internal/v1/jobs?op=merge */
  path: string;
  ws: string;
  user: string;
  maxBytes: number;
  body?: ReadableStream<Uint8Array> | null;
  contentLength?: number;
  contentType?: string;
  /** Unix seconds; defaults to now. */
  ts?: number;
}

export function canonical(method: string, pathQs: string, ts: string, nonce: string, ws: string, user: string, maxBytes: string, contentLength: string): string {
  return ["v1", method.toUpperCase(), pathQs, ts, nonce, ws, user, maxBytes, contentLength || "0"].join("\n");
}

const keyCache = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string) {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    if (keyCache.size > 8) keyCache.clear();
    keyCache.set(secret, k);
  }
  return k;
}

export async function signEngine(secret: string, method: string, pathQs: string, ts: string, nonce: string, ws: string, user: string, maxBytes: string, contentLength: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(canonical(method, pathQs, ts, nonce, ws, user, maxBytes, contentLength)));
  return toHex(sig);
}

type FixedLengthStreamCtor = new (n: number) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };

/** Signs and sends one call. Returns the engine's response untouched (its body is a stream). */
export async function engineFetch(fetcher: typeof fetch, cfg: EngineConfig, call: EngineCall): Promise<Response> {
  const ts = String(call.ts ?? Math.floor(Date.now() / 1000));
  const len = call.body ? (call.contentLength ?? 0) : 0;
  // The engine refuses a signature it has seen before; the nonce keeps two honest calls in one second apart.
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(12)));
  const sig = await signEngine(cfg.key, call.method, call.path, ts, nonce, call.ws, call.user, String(call.maxBytes), String(len));
  const headers: Record<string, string> = {
    "x-multies-key": cfg.keyId, "x-multies-ts": ts, "x-multies-nonce": nonce, "x-multies-ws": call.ws, "x-multies-user": call.user,
    "x-multies-max-bytes": String(call.maxBytes), "x-multies-sig": sig,
  };
  let body: ReadableStream<Uint8Array> | undefined;
  if (call.body) {
    headers["content-length"] = String(len);
    if (call.contentType) headers["content-type"] = call.contentType;
    body = call.body;
    // On Workers a FixedLengthStream keeps the length on the way out (no chunked upload), still without reading the file.
    const FLS = (globalThis as { FixedLengthStream?: FixedLengthStreamCtor }).FixedLengthStream;
    if (FLS) {
      const fixed = new FLS(len);
      void call.body.pipeTo(fixed.writable).catch(() => undefined);
      body = fixed.readable;
    }
  }
  const init: RequestInit & { duplex?: "half" } = { method: call.method, headers, body, redirect: "manual" };
  if (body) init.duplex = "half";
  return fetcher(`${cfg.url.replace(/\/$/, "")}${call.path}`, init);
}
