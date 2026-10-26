import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, mkdirSync } from "node:fs";
import { inspect } from "node:util";
import os from "node:os";
import path from "node:path";
// @ts-expect-error plain ESM script without types
import { parseCredentials, secretTokens, envWith, writeSecretFile, maskText, DEFAULT_PATH } from "../scripts/creds.mjs";
// @ts-expect-error plain ESM script without types
import { scan } from "../scripts/check-cred-leaks.mjs";
// @ts-expect-error plain ESM script without types
import { knownValues, maskLine } from "../scripts/redact-log.mjs";

// Fake values only. They look like the real shapes that leaked in R26.
const FIXTURE = [
  "# Fixture",
  "- Auth0 account password: Zq8!fakePw2k",
  "- Provisioner login (STALWART_ADMIN_USER / STALWART_ADMIN_SECRET): mymail-provisioner@mymail.test / f4keSecretValue0123456789abcdefABCDEF00",
  "AUTH0_CLIENT_SECRET (new)=QWERTYfake1234567890abcdefgh",
  "WEB_ANALYTICS_BEACON_TOKEN=publicBeacon1234567890abcd",
  "- Token name: multies-deploy",
  "- What it is: the test server on the build box",
].join("\n");
const entries = parseCredentials(FIXTURE);

describe("R27 credentials helper: values go to env or files, never to output", () => {
  it("parses NAME=value, labelled values and user / secret pairs into keys", () => {
    const keys = entries.map((e: { key: string }) => e.key);
    expect(keys).toContain("STALWART_ADMIN_USER");
    expect(keys).toContain("STALWART_ADMIN_SECRET");
    expect(keys).toContain("AUTH0_CLIENT_SECRET");
    expect(keys).toContain("Auth0 account password");
  });

  it("treats only credential-named, secret-shaped values as secrets (not names, prose or public beacons)", () => {
    const toks = secretTokens(entries);
    expect(toks).toContain("Zq8!fakePw2k");
    expect(toks).toContain("f4keSecretValue0123456789abcdefABCDEF00");
    expect(toks).toContain("QWERTYfake1234567890abcdefgh");
    expect(toks).not.toContain("multies-deploy");
    expect(toks).not.toContain("publicBeacon1234567890abcd");
    expect(toks.join(" ")).not.toContain("mymail-provisioner@mymail.test");
  });

  it("envWith puts the value in the env but every printed form of it is masked", () => {
    const env = envWith(["STALWART_ADMIN_SECRET"], { base: { PATH: "/bin" }, rename: { STALWART_ADMIN_SECRET: "STALWART_TEST_ADMIN_SECRET" }, entries });
    expect(env.STALWART_TEST_ADMIN_SECRET).toBe("f4keSecretValue0123456789abcdefABCDEF00");
    for (const printed of [inspect(env), JSON.stringify(env), String(env), `${env}`]) {
      expect(printed).not.toContain("f4keSecretValue0123456789abcdefABCDEF00");
    }
    expect(JSON.stringify(env)).toContain("[masked]");
    expect({ ...env }.STALWART_TEST_ADMIN_SECRET).toBe("f4keSecretValue0123456789abcdefABCDEF00"); // a spread copy still reaches a child process
  });

  it("an unknown key fails without echoing anything secret", () => {
    expect(() => envWith(["NOPE"], { entries })).toThrow(/no key named NOPE/);
  });

  it("writeSecretFile writes mode 600 and returns only the length", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "creds-"));
    const r = writeSecretFile("AUTH0_CLIENT_SECRET", path.join(dir, "s.txt"), { entries });
    expect(r).toEqual({ file: path.join(dir, "s.txt"), length: 28 });
    expect(statSync(r.file).mode & 0o777).toBe(0o600);
    expect(readFileSync(r.file, "utf8")).toBe("QWERTYfake1234567890abcdefgh");
  });

  it("maskText hides every secret token", () => {
    expect(maskText("pw Zq8!fakePw2k and f4keSecretValue0123456789abcdefABCDEF00", secretTokens(entries))).toBe("pw [masked] and [masked]");
  });

  it("redact-log now also masks the user / secret pair line that leaked in R26", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "creds-rl-"));
    mkdirSync(path.join(dir, "app"));
    writeFileSync(path.join(dir, "CREDENTIALS.local.md"), FIXTURE);
    const known = knownValues(path.join(dir, "app"), {});
    expect(maskLine("STALWART_TEST_ADMIN_SECRET=f4keSecretValue0123456789abcdefABCDEF00 ok", known)).not.toContain("f4keSecretValue");
  });
});

describe("R27 credential leak check over the task directories", () => {
  it("finds a planted value, names the key and file, never the value, and --scrub cleans it", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "leaks-"));
    mkdirSync(path.join(root, "task-a"));
    writeFileSync(path.join(root, "task-a", "run.log"), "deploy ok\nsecret was f4keSecretValue0123456789abcdefABCDEF00\n");
    writeFileSync(path.join(root, "task-a", "clean.log"), "nothing to see");
    writeFileSync(path.join(root, "task-a", "shot.png"), "f4keSecretValue0123456789abcdefABCDEF00"); // not a text file
    const r = scan({ roots: [root], entries });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].file).toBe(path.join(root, "task-a", "run.log"));
    expect(r.hits[0].keys).toEqual(["STALWART_ADMIN_SECRET"]);
    expect(JSON.stringify(r)).not.toContain("f4keSecretValue");
    scan({ roots: [root], entries, scrub: true });
    expect(readFileSync(path.join(root, "task-a", "run.log"), "utf8")).toContain("[redacted]");
    expect(scan({ roots: [root], entries }).hits).toHaveLength(0);
  });

  it("uses a clean-file cache so repeat runs only read changed files", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "leaks-cache-"));
    writeFileSync(path.join(root, "a.log"), "clean");
    const cacheFile = path.join(root, ".cache.json");
    expect(scan({ roots: [root], entries, cacheFile }).hits).toHaveLength(0);
    writeFileSync(path.join(root, "a.log"), "now Zq8!fakePw2k leaked");
    expect(scan({ roots: [root], entries, cacheFile }).hits).toHaveLength(1);
  });

  const live = existsSync(DEFAULT_PATH) && existsSync("/home/user/tab/tasks");
  it.runIf(live)("no CREDENTIALS value is in any log under /home/user/tab/tasks (live check on the build box)", () => {
    const r = scan({ roots: ["/home/user/tab/tasks"], cacheFile: path.join(os.homedir(), ".cache", "multies-cred-leak-scan.json") });
    expect(r.hits.map((h: { file: string; keys: string[] }) => `${h.file}: ${h.keys.join(", ")}`)).toEqual([]);
  }, 120_000);
});
