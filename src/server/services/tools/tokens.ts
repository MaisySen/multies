/**
 * Job tokens: an HMAC signed blob naming the engine job, workspace, user, op, result name and expiry,
 * so polling and download need no D1 read. A status token ("s") lasts 2 hours from the upload; a
 * download token ("d") is minted when the job is done and lasts 60 minutes (the engine deletes the
 * output 60 minutes after it is made). Not secret, only tamper proof: it carries nothing the holder
 * does not already know.
 */
import { safeEqual, hmacSha256Hex } from "../../lib/crypto";
import type { ToolOp } from "@/shared/tools";

export const STATUS_TOKEN_SECONDS = 2 * 60 * 60;
export const DOWNLOAD_TOKEN_SECONDS = 60 * 60;

export interface ToolToken { k: "s" | "d"; j: string; w: string; u: string; o: ToolOp; n: string; e: number }

const b64u = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0)));

export async function mintToken(key: string, t: Omit<ToolToken, "e">, nowMs: number): Promise<string> {
  const ttl = t.k === "s" ? STATUS_TOKEN_SECONDS : DOWNLOAD_TOKEN_SECONDS;
  const payload = b64u(JSON.stringify({ ...t, e: Math.floor(nowMs / 1000) + ttl }));
  return `${payload}.${(await hmacSha256Hex(key, `tools.v1.${payload}`)).slice(0, 43)}`;
}

/** The token's fields when the signature holds, the kind matches and it has not expired; otherwise null. */
export async function readToken(key: string, token: string, kind: ToolToken["k"], nowMs: number): Promise<ToolToken | null> {
  if (token.length > 1200) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const want = (await hmacSha256Hex(key, `tools.v1.${payload}`)).slice(0, 43);
  if (!safeEqual(want, token.slice(dot + 1))) return null;
  try {
    const t = JSON.parse(unb64u(payload)) as ToolToken;
    if (t.k !== kind || typeof t.e !== "number" || t.e * 1000 <= nowMs) return null;
    if (typeof t.j !== "string" || !/^[a-f0-9]{16,64}$/.test(t.j)) return null;
    return t;
  } catch { return null; }
}
