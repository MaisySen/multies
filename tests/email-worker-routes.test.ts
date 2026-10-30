import { describe, expect, it } from "vitest";
import { targetFor, type Env } from "../email-worker/src/index";

const base: Env = { MYMAIL_WEBHOOK_URL: "https://preview.example/api/inbound/cloudflare", MYMAIL_KEY_ID: "ink_preview", MYMAIL_KEY_SECRET: "s1" };

describe("email worker routing", () => {
  it("sends a routed domain to its own host with its own key", () => {
    const env: Env = { ...base, MYMAIL_KEY_SECRET_PROD: "s2", MYMAIL_ROUTES: JSON.stringify({ "multies.si": { url: "https://multies.si/api/inbound/cloudflare", keyId: "ink_prod", secret: "MYMAIL_KEY_SECRET_PROD" } }) };
    expect(targetFor(env, "Security@Multies.si")).toEqual({ url: "https://multies.si/api/inbound/cloudflare", keyId: "ink_prod", secret: "s2" });
    expect(targetFor(env, "hello@northwind.test")).toEqual({ url: base.MYMAIL_WEBHOOK_URL, keyId: "ink_preview", secret: "s1" });
  });
  it("falls back to the default host when the route is broken or its secret is missing", () => {
    expect(targetFor({ ...base, MYMAIL_ROUTES: "{" }, "a@multies.si").keyId).toBe("ink_preview");
    expect(targetFor({ ...base, MYMAIL_ROUTES: JSON.stringify({ "multies.si": { url: "x", keyId: "k", secret: "NOPE" } }) }, "a@multies.si").keyId).toBe("ink_preview");
  });
});
