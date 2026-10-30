import * as Crypto from "expo-crypto";
import * as WebBrowser from "expo-web-browser";
import { IDP } from "@/config";

/**
 * OAuth 2.0 Authorization Code with PKCE (RFC 7636) for a native app (RFC 8252): the system
 * browser shows the Multies sign in page, our custom scheme brings the code back, and the
 * app swaps it for tokens with the code verifier. Only the ID token leaves this function,
 * straight to the Multies server, which checks it again against the provider's keys.
 */

export class IdpError extends Error {
  constructor(public code: "cancelled" | "state" | "denied" | "token" | "network", message: string) { super(message); }
}

export function base64url(b64: string) {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(bytes = 32) {
  const raw = Crypto.getRandomBytes(bytes);
  let s = "";
  for (const b of raw) s += String.fromCharCode(b);
  return base64url(globalThis.btoa(s));
}

export async function pkcePair() {
  const verifier = randomString(48); // 64 characters, inside RFC 7636's 43 to 128
  const challenge = base64url(await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, { encoding: Crypto.CryptoEncoding.BASE64 }));
  return { verifier, challenge };
}

export interface AuthorizeRequest { url: string; state: string; nonce: string; verifier: string }

export async function buildAuthorizeRequest(mode: "signin" | "signup" = "signin"): Promise<AuthorizeRequest> {
  const { verifier, challenge } = await pkcePair();
  const state = randomString(24);
  const nonce = randomString(24);
  const q = new URLSearchParams({
    response_type: "code", client_id: IDP.clientId, redirect_uri: IDP.redirectUri, scope: "openid profile email",
    state, nonce, code_challenge: challenge, code_challenge_method: "S256",
  });
  if (mode === "signup") q.set("screen_hint", "signup");
  return { url: `https://${IDP.domain}/authorize?${q.toString()}`, state, nonce, verifier };
}

/** Reads the redirect the browser handed back; refuses a state we did not send. */
export function readCallback(url: string, expectedState: string): string {
  const query = url.includes("?") ? url.slice(url.indexOf("?") + 1).split("#")[0] : "";
  const p = new URLSearchParams(query);
  if (p.get("state") !== expectedState) throw new IdpError("state", "That sign in did not come back intact. Please try again.");
  const err = p.get("error");
  if (err) throw new IdpError("denied", p.get("error_description") || "Sign in was not completed.");
  const code = p.get("code");
  if (!code) throw new IdpError("denied", "Sign in was not completed.");
  return code;
}

/** Runs the whole browser step and returns the ID token plus the nonce it must carry. */
export async function signInAtIdp(mode: "signin" | "signup" = "signin"): Promise<{ idToken: string; nonce: string }> {
  const req = await buildAuthorizeRequest(mode);
  const result = await WebBrowser.openAuthSessionAsync(req.url, IDP.redirectUri, { preferEphemeralSession: false });
  if (result.type !== "success" || !("url" in result) || !result.url) throw new IdpError("cancelled", "Sign in was cancelled.");
  const code = readCallback(result.url, req.state);
  let res: Response;
  try {
    res = await fetch(`https://${IDP.domain}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: IDP.clientId, code, code_verifier: req.verifier, redirect_uri: IDP.redirectUri }).toString(),
    });
  } catch {
    throw new IdpError("network", "Can't reach the sign in service. Check your connection.");
  }
  const body = (await res.json().catch(() => ({}))) as { id_token?: string };
  if (!res.ok || !body.id_token) throw new IdpError("token", "Sign in could not be finished. Please try again.");
  return { idToken: body.id_token, nonce: req.nonce };
}
