import { describe, it, expect } from "vitest";
import {
  hashPassword, verifyPassword, encryptSecret, decryptSecret, generateDkimKeyPair, hmacSha256Hex, newId, safeEqual,
} from "@/server/lib/crypto";
import { loadConfig, ConfigError } from "@/server/config";

describe("passwords", () => {
  it("hash and verify", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(h.startsWith("pbkdf2_sha256$100000$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
  });
  it("salts every hash", async () => {
    expect(await hashPassword("same-password")).not.toEqual(await hashPassword("same-password"));
  });
});

describe("secrets at rest", () => {
  it("round-trips and rejects the wrong key", async () => {
    const ct = await encryptSecret("k".repeat(40), "top secret");
    expect(ct).not.toContain("top secret");
    expect(await decryptSecret("k".repeat(40), ct)).toBe("top secret");
    await expect(decryptSecret("x".repeat(40), ct)).rejects.toThrow();
  });
});

describe("DKIM keys", () => {
  it("generates an RSA-2048 keypair in DNS-ready form", async () => {
    const { publicKeyB64, privateKeyPem } = await generateDkimKeyPair();
    expect(publicKeyB64).toMatch(/^MIIBIjAN/); // SPKI header for RSA-2048
    expect(privateKeyPem).toContain("BEGIN PRIVATE KEY");
  });
});

describe("misc", () => {
  it("hmac is deterministic, ids are prefixed, compare is exact", async () => {
    expect(await hmacSha256Hex("s", "m")).toEqual(await hmacSha256Hex("s", "m"));
    expect(newId("dom")).toMatch(/^dom_[0-9a-z]{16}$/);
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
  });
});

describe("config", () => {
  it("refuses production without a strong secret", () => {
    expect(() => loadConfig({ APP_MODE: "production" })).toThrow(ConfigError);
  });
  it("defaults to Cloudflare Email Routing and the log driver", () => {
    const c = loadConfig({});
    expect(c.mail.mxHosts[0].host).toBe("route1.mx.cloudflare.net");
    expect(c.outbound.driver).toBe("log");
    expect(c.demoEnabled).toBe(false);
  });
  it("parses custom MX hosts", () => {
    const c = loadConfig({ MAIL_MX_HOSTS: "mx1.example.net:5,mx2.example.net:15" });
    expect(c.mail.mxHosts).toEqual([{ host: "mx1.example.net", priority: 5 }, { host: "mx2.example.net", priority: 15 }]);
  });
  it("treats restricted test keys as Stripe test mode", () => {
    expect(loadConfig({ STRIPE_SECRET_KEY: "rk_test_abc" }).billing.testMode).toBe(true);
    expect(loadConfig({ STRIPE_SECRET_KEY: "sk_test_abc" }).billing.testMode).toBe(true);
    expect(loadConfig({ STRIPE_SECRET_KEY: "rk_live_abc" }).billing.testMode).toBe(false);
  });
});
