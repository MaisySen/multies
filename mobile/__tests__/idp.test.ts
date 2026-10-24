import { base64url, buildAuthorizeRequest, readCallback, signInAtIdp, IdpError } from "@/lib/idp";
import * as WebBrowser from "expo-web-browser";

jest.mock("expo-web-browser", () => ({ openBrowserAsync: jest.fn(async () => ({})), openAuthSessionAsync: jest.fn() }));

const { createHash } = require("crypto");

describe("sign in at the identity provider (PKCE)", () => {
  it("builds an authorize URL with S256 PKCE, state, nonce and the app's callback", async () => {
    const req = await buildAuthorizeRequest("signin");
    const u = new URL(req.url);
    expect(u.pathname).toBe("/authorize");
    const q = u.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("redirect_uri")).toBe("mymail://auth/callback");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toBe(base64url(createHash("sha256").update(req.verifier).digest("base64")));
    expect(req.verifier.length).toBeGreaterThanOrEqual(43);
    expect(q.get("state")).toBe(req.state);
    expect(q.get("nonce")).toBe(req.nonce);
    expect(q.get("screen_hint")).toBeNull();
    expect(new URL((await buildAuthorizeRequest("signup")).url).searchParams.get("screen_hint")).toBe("signup");
  });

  it("refuses a callback with another state and reports provider errors", () => {
    expect(readCallback("mymail://auth/callback?code=abc&state=s1", "s1")).toBe("abc");
    expect(() => readCallback("mymail://auth/callback?code=abc&state=evil", "s1")).toThrow(IdpError);
    expect(() => readCallback("mymail://auth/callback?error=access_denied&error_description=No&state=s1", "s1")).toThrow("No");
  });

  it("swaps the code with the verifier and returns the ID token and nonce", async () => {
    let sent: URLSearchParams | null = null;
    (WebBrowser.openAuthSessionAsync as jest.Mock).mockImplementation(async (url: string) => {
      const state = new URL(url).searchParams.get("state");
      return { type: "success", url: `mymail://auth/callback?code=the-code&state=${state}` };
    });
    global.fetch = jest.fn(async (_url: string, init: { body: string }) => {
      sent = new URLSearchParams(init.body);
      return { ok: true, json: async () => ({ id_token: "header.payload.sig" }) };
    }) as unknown as typeof fetch;
    const r = await signInAtIdp();
    expect(r.idToken).toBe("header.payload.sig");
    expect(r.nonce.length).toBeGreaterThan(10);
    expect(sent!.get("grant_type")).toBe("authorization_code");
    expect(sent!.get("code")).toBe("the-code");
    expect(sent!.get("code_verifier")!.length).toBeGreaterThanOrEqual(43);
    expect(sent!.get("client_secret")).toBeNull();
  });

  it("says cancelled when the person closes the browser", async () => {
    (WebBrowser.openAuthSessionAsync as jest.Mock).mockResolvedValue({ type: "cancel" });
    await expect(signInAtIdp()).rejects.toMatchObject({ code: "cancelled" });
  });
});
