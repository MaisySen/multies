import { describe, expect, it } from "vitest";
import { maskSecretText, secretValuesFromEnv } from "../src/shared/secret-mask";
import { redact } from "../src/server/lib/logger";
// @ts-expect-error plain ESM script without types
import { maskLine, valuesFromText } from "../scripts/redact-log.mjs";

describe("R26 secret masking", () => {
  it("masks a short password with punctuation by its name, the case a length rule missed", () => {
    const line = "- Auth0 account password: Ab3!xY9q";
    expect(maskSecretText(line)).not.toContain("Ab3!xY9q");
    expect(valuesFromText(line)).toEqual(["Ab3!xY9q"]);
    expect(maskLine("typed Ab3!xY9q into the form", valuesFromText(line))).toBe("typed [masked] into the form");
  });

  it("masks name=value pairs with a note in the name, bearer tokens, JWTs and provider keys", () => {
    const s = [
      "AUTH0_MGMT_CLIENT_SECRET (new, app Worker secret)=q1w2e3r4t5y6u7i8o9p0",
      'body {"client_secret":"abcdefghijkl"}',
      "authorization: Bearer abcdef123456789",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl",
      "key re_abcdefghijklmnop and whsec_abcdefghijklmnop",
    ].join("\n");
    const out = maskSecretText(s);
    for (const leak of ["q1w2e3r4t5y6u7i8o9p0", "abcdefghijkl", "abcdef123456789", "eyJhbGciOiJIUzI1NiJ9", "re_abcdefghijklmnop", "whsec_abcdefghijklmnop"]) expect(out).not.toContain(leak);
    expect(out).toContain("AUTH0_MGMT_CLIENT_SECRET (new, app Worker secret)=[masked]");
  });

  it("masks known env values wherever they appear, and leaves ordinary words alone", () => {
    const known = secretValuesFromEnv({ RESEND_API_KEY: "zz-very-private-zz", APP_URL: "https://multies.si", SHORT_TOKEN: "abc" });
    expect(known).toEqual(["zz-very-private-zz"]);
    expect(maskSecretText("sent with zz-very-private-zz to https://multies.si", known)).toBe("sent with [masked] to https://multies.si");
    expect(maskSecretText("Tasks: 152 open, status ok")).toBe("Tasks: 152 open, status ok");
  });

  it("logger redacts nested credential keys and secrets inside error messages", () => {
    const out = redact({ req: { headers: { authorization: "Bearer abcdefghijk" }, url: "/x?token=abcdefghijk" }, error: new Error("token 401 client_secret=abcdefghijk"), n: 3 }) as Record<string, any>;
    expect(out.req.headers.authorization).toBe("[redacted]");
    expect(out.req.url).not.toContain("abcdefghijk");
    expect(out.error.message).not.toContain("abcdefghijk");
    expect(out.n).toBe(3);
    expect(JSON.stringify(out)).not.toContain("abcdefghijk");
  });
});
