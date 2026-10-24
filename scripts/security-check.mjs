#!/usr/bin/env node
/**
 * npm run security: the release checklist's security gate. Runs, in order:
 *  1. npm audit on shipped dependencies (fails on high or critical) and on everything (fails on critical),
 *  2. gitleaks over the whole git history and the working tree (fails on any finding),
 *  3. the authorisation tests: every route without a session, and the cross-workspace isolation sweep.
 * gitleaks is an MIT licensed binary: it is used from PATH, else downloaded once into
 * node_modules/.cache/gitleaks from its GitHub release and checked against the release checksum.
 * Exit code 0 means every step passed. Local only: nothing here touches a deployed host.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

const GITLEAKS_VERSION = "8.28.0";
const root = new URL("..", import.meta.url).pathname;
const failures = [];

function run(label, cmd, args, opts = {}) {
  process.stdout.write(`\n== ${label}\n`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
  if (r.status !== 0) failures.push(label);
  return r.status === 0;
}

function which(bin) {
  const r = spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

async function gitleaksBinary() {
  const onPath = which("gitleaks");
  if (onPath) return onPath;
  const dir = join(root, "node_modules/.cache/gitleaks");
  const bin = join(dir, "gitleaks");
  if (existsSync(bin)) return bin;
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("Install gitleaks (https://github.com/gitleaks/gitleaks) and put it on PATH.");
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const name = `gitleaks_${GITLEAKS_VERSION}_${process.platform}_${arch}.tar.gz`;
  const base = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}`;
  const [tarball, sums] = await Promise.all([
    fetch(`${base}/${name}`).then((r) => { if (!r.ok) throw new Error(`gitleaks download: ${r.status}`); return r.arrayBuffer(); }),
    fetch(`${base}/gitleaks_${GITLEAKS_VERSION}_checksums.txt`).then((r) => r.text()),
  ]);
  const want = sums.split("\n").find((l) => l.endsWith(` ${name}`))?.split(/\s+/)[0];
  const got = createHash("sha256").update(Buffer.from(tarball)).digest("hex");
  if (!want || want !== got) throw new Error("gitleaks download did not match its published checksum.");
  mkdirSync(dir, { recursive: true });
  const tgz = join(dir, name);
  writeFileSync(tgz, Buffer.from(tarball));
  spawnSync("tar", ["xzf", tgz, "-C", dir, "gitleaks"], { stdio: "inherit" });
  chmodSync(bin, 0o755);
  return bin;
}

run("npm audit: shipped dependencies, high and critical", "npm", ["audit", "--omit=dev", "--audit-level=high"]);
run("npm audit: all dependencies, critical", "npm", ["audit", "--audit-level=critical"]);

try {
  const gl = await gitleaksBinary();
  const config = existsSync(join(root, ".gitleaks.toml")) ? ["--config", join(root, ".gitleaks.toml")] : [];
  run("gitleaks: whole git history", gl, ["git", "--no-banner", "--redact", "--exit-code", "1", ...config, "."]);
  // Changes not committed yet, staged and unstaged (what the pre-commit hook would see).
  run("gitleaks: staged changes", gl, ["git", "--pre-commit", "--staged", "--no-banner", "--redact", "--exit-code", "1", ...config, "."]);
  run("gitleaks: unstaged changes", gl, ["git", "--pre-commit", "--no-banner", "--redact", "--exit-code", "1", ...config, "."]);
} catch (err) {
  process.stdout.write(`\n== gitleaks\n${err.message}\n`);
  failures.push("gitleaks");
}

run("authorisation and isolation tests", "npx", ["vitest", "run", "tests/authz-matrix.test.ts", "tests/isolation-sweep.test.ts", "tests/security-r11.test.ts", "tests/hardening.test.ts"]);

if (failures.length) {
  process.stdout.write(`\nSecurity checks failed: ${failures.join("; ")}\n`);
  process.exit(1);
}
process.stdout.write("\nSecurity checks passed.\n");
