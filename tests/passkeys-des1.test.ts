/**
 * DES1 passkeys (PASSKEY_DES1): add, sign in, replay, wrong origin, counter regression, rename, remove and the flag
 * off path, driven by a small software authenticator (ES256 over node:crypto, CBOR by hand, attestation "none").
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createHash, generateKeyPairSync, randomBytes, sign as edSign, type KeyObject } from "node:crypto";
import { makeTestApp, Client } from "./helpers";
import { passkeysDes1 } from "../src/server/db/schema-des1";

const ORIGIN = "http://localhost:5173";
const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");

/** Just enough CBOR for an attestation object and a COSE key. */
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const s = Buffer.from(v, "utf8"); return Buffer.concat([head(3, s.length), s]); }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("cbor: unsupported");
}

class SoftAuthenticator {
  key = generateKeyPairSync("ec", { namedCurve: "P-256" });
  credId = randomBytes(32);
  counter = 0;
  constructor(public rpId = "localhost", public origin = ORIGIN) {}
  get id() { return b64u(this.credId); }
  private rpHash() { return createHash("sha256").update(this.rpId).digest(); }
  private counterBytes() { const b = Buffer.alloc(4); b.writeUInt32BE(this.counter); return b; }
  private cose() {
    const jwk = (this.key.publicKey as KeyObject).export({ format: "jwk" }) as { x: string; y: string };
    return cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  create(options: any) {
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const idLen = Buffer.alloc(2); idLen.writeUInt16BE(this.credId.length);
    const authData = Buffer.concat([this.rpHash(), Buffer.from([0x45]), this.counterBytes(), Buffer.alloc(16), idLen, this.credId, this.cose()]);
    const att = cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return { id: this.id, rawId: this.id, type: "public-key", clientExtensionResults: {}, authenticatorAttachment: "platform",
      response: { clientDataJSON: b64u(clientData), attestationObject: b64u(att), transports: ["internal"] } };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(options: any, opts: { bump?: boolean } = {}) {
    if (opts.bump !== false) this.counter += 1;
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const authData = Buffer.concat([this.rpHash(), Buffer.from([0x05]), this.counterBytes()]);
    const sig = edSign("sha256", Buffer.concat([authData, createHash("sha256").update(clientData).digest()]), this.key.privateKey);
    return { id: this.id, rawId: this.id, type: "public-key", clientExtensionResults: {}, authenticatorAttachment: "platform",
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(sig) } };
  }
}

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
beforeEach(async () => { ctx = await makeTestApp({ PASSKEY_DES1: "on" }); });

async function addKey(c: Client, auth = new SoftAuthenticator()) {
  const o = await c.post("/api/passkeys/register/options", {});
  expect(o.status).toBe(200);
  const r = await c.post("/api/passkeys/register", { response: auth.create(o.body.options), name: "My phone" });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { auth, id: r.body.id as string };
}
async function signIn(auth: SoftAuthenticator, opts: { bump?: boolean } = {}) {
  const c = new Client(ctx.app);
  const o = await c.post("/api/passkeys/sign-in/options", {});
  expect(o.status).toBe(200);
  const assertion = auth.get(o.body.options, opts);
  const r = await c.post("/api/passkeys/sign-in", { response: assertion });
  return { c, r, assertion, options: o.body.options };
}

describe("DES1 passkeys", () => {
  it("answers 404 everywhere while the flag is off", async () => {
    const off = await makeTestApp();
    const c = new Client(off.app);
    await c.signup("off@example.com");
    for (const [m, p] of [["GET", "/api/passkeys"], ["POST", "/api/passkeys/register/options"], ["POST", "/api/passkeys/sign-in/options"], ["POST", "/api/passkeys/sign-in"]] as const) {
      expect((await c.call(m, p, m === "POST" ? {} : undefined)).status).toBe(404);
    }
    expect((await c.get("/api/config")).body.passkeyDes1).toBe(false);
  });

  it("adds a passkey, lists it with public facts only, and signs in with it", async () => {
    const c = new Client(ctx.app);
    await c.signup("ada@example.com");
    const { auth } = await addKey(c);
    const list = await c.get("/api/passkeys");
    expect(list.status).toBe(200);
    expect(list.body.passkeys).toHaveLength(1);
    expect(list.body.passkeys[0]).toMatchObject({ name: "My phone", lastUsedAt: null });
    expect(JSON.stringify(list.body)).not.toMatch(/publicKey|credentialId|counter/);
    const { c: fresh, r } = await signIn(auth);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const me = await fresh.get("/api/account/me");
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("ada@example.com");
    const [row] = await ctx.db.select().from(passkeysDes1);
    expect(row.counter).toBe(1);
    expect(row.lastUsedAt).not.toBeNull();
  });

  it("refuses a replayed assertion and a reused challenge", async () => {
    const c = new Client(ctx.app);
    await c.signup();
    const { auth } = await addKey(c);
    const first = await signIn(auth);
    expect(first.r.status).toBe(200);
    const again = await first.c.post("/api/passkeys/sign-in", { response: first.assertion });
    expect(again.status).toBe(400);
    const other = new Client(ctx.app);
    await other.post("/api/passkeys/sign-in/options", {});
    expect((await other.post("/api/passkeys/sign-in", { response: first.assertion })).status).toBe(401);
  });

  it("refuses a passkey made for another origin, on add and on sign in", async () => {
    const c = new Client(ctx.app);
    await c.signup();
    const evil = new SoftAuthenticator("localhost", "https://evil.example");
    const o = await c.post("/api/passkeys/register/options", {});
    const bad = await c.post("/api/passkeys/register", { response: evil.create(o.body.options) });
    expect(bad.status).toBe(400);
    expect((await c.get("/api/passkeys")).body.passkeys).toHaveLength(0);
    const { auth } = await addKey(c);
    auth.origin = "https://multies.si.workers.dev";
    expect((await signIn(auth)).r.status).toBe(401);
    auth.origin = ORIGIN;
    auth.rpId = "evil.example";
    expect((await signIn(auth)).r.status).toBe(401);
  });

  it("refuses a counter that went backwards and audits it", async () => {
    const c = new Client(ctx.app);
    await c.signup();
    const { auth } = await addKey(c);
    expect((await signIn(auth)).r.status).toBe(200);
    expect((await signIn(auth)).r.status).toBe(200);
    auth.counter = 1;
    expect((await signIn(auth, { bump: false })).r.status).toBe(401);
    const audit = await ctx.db.query.auditLogs.findMany();
    expect(audit.some((a) => a.action === "passkey.counter_regression")).toBe(true);
  });

  it("renames, keeps others' passkeys out of reach, and removes only with a fresh sign in", async () => {
    const c = new Client(ctx.app);
    await c.signup("owner@example.com");
    const { id, auth } = await addKey(c);
    expect((await c.patch(`/api/passkeys/${id}`, { name: "  Work laptop  " })).status).toBe(200);
    expect((await c.get("/api/passkeys")).body.passkeys[0].name).toBe("Work laptop");
    expect((await c.patch(`/api/passkeys/${id}`, { name: "   " })).status).toBe(400);

    const stranger = new Client(ctx.app);
    await stranger.signup("stranger@example.com");
    expect((await stranger.patch(`/api/passkeys/${id}`, { name: "mine" })).status).toBe(404);
    expect((await stranger.del(`/api/passkeys/${id}`)).status).toBe(404);

    const realNow = ctx.deps.now;
    ctx.deps.now = () => new Date(Date.now() + 16 * 60_000);
    const stale = await c.del(`/api/passkeys/${id}`);
    expect(stale.status).toBe(403);
    expect(stale.body.error?.code ?? stale.body.code).toBe("reauth_required");
    ctx.deps.now = realNow;
    expect((await c.del(`/api/passkeys/${id}`)).status).toBe(200);
    expect((await c.get("/api/passkeys")).body.passkeys).toHaveLength(0);
    expect((await signIn(auth)).r.status).toBe(401);
  });

  it("refuses the same passkey twice and keeps the challenge cookie scoped and strict", async () => {
    const c = new Client(ctx.app);
    await c.signup();
    const auth = new SoftAuthenticator();
    await addKey(c, auth);
    const o = await c.post("/api/passkeys/register/options", {});
    expect((await c.post("/api/passkeys/register", { response: auth.create(o.body.options) })).status).toBe(409);
    const raw = await ctx.app.request("/api/passkeys/sign-in/options", { method: "POST", headers: { "content-type": "application/json", host: "localhost" }, body: "{}" });
    const sc = raw.headers.getSetCookie().join(";");
    expect(sc).toMatch(/Path=\/api\/passkeys/);
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/SameSite=Strict/);
    expect(raw.headers.get("cache-control")).toMatch(/no-store/);
  });
});
