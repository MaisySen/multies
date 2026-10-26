import { describe, it, expect } from "vitest";
import { b64urlDecode, b64urlEncode, decryptPayload, encryptPayload, vapidJwt, publicJwk, buildWebPushRequest, isAllowedEndpoint, privateD } from "@/server/lib/web-push";

/** RFC 8291 Appendix A: the worked example, byte for byte. */
const V = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  message: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

describe("web push encryption (RFC 8291)", () => {
  it("matches the RFC 8291 example message exactly", async () => {
    const out = await encryptPayload(new TextEncoder().encode(V.plaintext), V.uaPublic, V.auth, { salt: b64urlDecode(V.salt), serverKeys: { publicRaw: b64urlDecode(V.asPublic), privateD: V.asPrivate } });
    expect(b64urlEncode(out)).toBe(V.message);
  });

  it("decrypts the RFC example with the user agent's key", async () => {
    const plain = await decryptPayload(b64urlDecode(V.message), V.uaPrivate, V.uaPublic, V.auth);
    expect(new TextDecoder().decode(plain)).toBe(V.plaintext);
  });

  it("round trips a random message with a fresh server key and salt", async () => {
    const a = await encryptPayload(new TextEncoder().encode("{\"type\":\"task.assigned\"}"), V.uaPublic, V.auth);
    const b = await encryptPayload(new TextEncoder().encode("{\"type\":\"task.assigned\"}"), V.uaPublic, V.auth);
    expect(b64urlEncode(a)).not.toBe(b64urlEncode(b));
    expect(new TextDecoder().decode(await decryptPayload(a, V.uaPrivate, V.uaPublic, V.auth))).toBe("{\"type\":\"task.assigned\"}");
  });

  it("refuses a bad auth secret and a payload too big for one record", async () => {
    await expect(encryptPayload(new Uint8Array(4), V.uaPublic, "AAAA")).rejects.toThrow(/16 bytes/);
    await expect(encryptPayload(new Uint8Array(5000), V.uaPublic, V.auth)).rejects.toThrow(/too large/);
  });
});

describe("VAPID (RFC 8292)", () => {
  const keys = { publicKey: V.asPublic, privateKey: V.asPrivate, subject: "mailto:security@multies.si" };

  it("signs an ES256 JWT for the push service origin that verifies with the public key", async () => {
    const now = Date.UTC(2026, 9, 26);
    const jwt = await vapidJwt("https://fcm.googleapis.com/fcm/send/abc", keys, now);
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(h)))).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(c)));
    expect(claims).toEqual({ aud: "https://fcm.googleapis.com", exp: now / 1000 + 12 * 3600, sub: "mailto:security@multies.si" });
    expect(b64urlDecode(s).length).toBe(64);
    const pub = await crypto.subtle.importKey("jwk", publicJwk(b64urlDecode(V.asPublic)), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, b64urlDecode(s), new TextEncoder().encode(`${h}.${c}`))).toBe(true);
  });

  it("takes the private key as a bare d or as a JWK", () => {
    expect(privateD(V.asPrivate)).toBe(V.asPrivate);
    expect(privateD(JSON.stringify({ kty: "EC", d: V.asPrivate }))).toBe(V.asPrivate);
    expect(() => privateD("{\"kty\":\"EC\"}")).toThrow();
  });

  it("builds the request: aes128gcm body, TTL, urgency, vapid authorization, cleaned topic", async () => {
    const r = await buildWebPushRequest({ endpoint: "https://updates.push.services.mozilla.com/wpush/v2/x", p256dh: V.uaPublic, auth: V.auth }, { type: "task.assigned", id: "tsk_1" }, keys, { topic: "task:tsk_1" });
    const h = r.init.headers as Record<string, string>;
    expect(h["content-encoding"]).toBe("aes128gcm");
    expect(h.ttl).toBe("86400");
    expect(h.topic).toBe("tasktsk_1");
    expect(h.authorization).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${V.asPublic}$`));
    const body = new Uint8Array(r.init.body as ArrayBuffer);
    expect(JSON.parse(new TextDecoder().decode(await decryptPayload(body, V.uaPrivate, V.uaPublic, V.auth)))).toEqual({ type: "task.assigned", id: "tsk_1" });
  });

  it("only sends to public https push endpoints", () => {
    expect(isAllowedEndpoint("https://fcm.googleapis.com/fcm/send/x")).toBe(true);
    expect(isAllowedEndpoint("http://fcm.googleapis.com/x")).toBe(false);
    expect(isAllowedEndpoint("https://localhost/x")).toBe(false);
    expect(isAllowedEndpoint("https://10.0.0.1/x")).toBe(false);
    expect(isAllowedEndpoint("https://[::1]/x")).toBe(false);
    expect(isAllowedEndpoint("nope")).toBe(false);
  });
});
