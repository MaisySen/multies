/**
 * W4: the leaked-password check (PASSWORD_BREACH_CHECK, on by default in production). makeTestApp turns it off because
 * tests have no network; here it is on, with the Have I Been Pwned range API stubbed. Only the first five characters
 * of the password's SHA-1 leave the server.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, makeTestApp } from "./helpers";

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex").toUpperCase();
const BREACHED = "correct-horse-battery";
const CLEAN = "a-strong-password";

function stubRange() {
  const asked: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    const m = /^https:\/\/api\.pwnedpasswords\.com\/range\/([0-9A-F]{5})$/.exec(url);
    if (!m) throw new Error(`unexpected fetch ${url}`);
    asked.push(m[1]!);
    const h = sha1(BREACHED);
    // The answer for a prefix lists suffixes with counts; padding rows carry a count of 0.
    const body = m[1] === h.slice(0, 5) ? `${h.slice(5)}:4120\r\n${"0".repeat(35)}:0` : `${"F".repeat(35)}:0`;
    return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
  }));
  return asked;
}

afterEach(() => vi.unstubAllGlobals());

describe("W4: leaked password check", () => {
  it("is off in tests unless asked for", async () => {
    const ctx = await makeTestApp({ APP_MODE: "production" });
    expect(ctx.deps.config.auth.breachCheck).toBe(false);
    expect((await makeTestApp({ PASSWORD_BREACH_CHECK: "true" })).deps.config.auth.breachCheck).toBe(true);
  });

  it("refuses a sign up with a breached password and accepts a clean one, sending only the hash prefix", async () => {
    const asked = stubRange();
    const ctx = await makeTestApp({ PASSWORD_BREACH_CHECK: "true" });

    const bad = await new Client(ctx.app).post("/api/auth/sign-up/email", { name: "Ada", email: "leaked@acme.io", password: BREACHED });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toMatch(/appeared in a data breach/);

    const good = await new Client(ctx.app).post("/api/auth/sign-up/email", { name: "Ada", email: "clean@acme.io", password: CLEAN });
    expect(good.status).toBe(200);

    expect(asked).toEqual([sha1(BREACHED).slice(0, 5), sha1(CLEAN).slice(0, 5)]);
  });
});
