#!/usr/bin/env node
/**
 * Worker and static-asset release sealer and verifier.
 *
 * Seals dist/worker into a manifest outside dist/worker (dist/worker-release.json)
 * so the bundled Worker (_worker.js), _headers, .assetsignore, and static assets are
 * verified as one atomic package before D1 migrations or wrangler deploy.
 *
 * Usage:
 *   node scripts/verify-worker-release.mjs [--dir dist/worker] [--seal dist/worker-release.json]
 *                                          [--release <id>] [--previous <prev-seal.json>]
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_ASSETS_IGNORE = ["_worker.js", "_worker.js.map", "tab-site.json", ".assetsignore"];
const EXCLUDED_PUBLIC_FILES = new Set([...REQUIRED_ASSETS_IGNORE, "_headers"]);
const FORBIDDEN_PUBLIC_FILES = new Set([
  "index.html",
  "landing.html",
  "auth.html",
  "public-pages.json",
  "auth-login.json",
  "worker-release.json",
]);
const SAFE_ASSET_NAME = /^[A-Za-z0-9_.-]+$/;

function sha256Buffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function toPosix(rel) {
  return rel.split(path.sep).join("/");
}

/** Extract all /assets/<file> references from embedded HTML shells. */
export function extractBootReferences(texts) {
  const refs = new Set();
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(/(?:^|["'(\s=,])\/?assets\/([A-Za-z0-9_.-]+\.[a-z0-9]{1,8})/g)) {
      if (SAFE_ASSET_NAME.test(m[1])) refs.add(`assets/${m[1]}`);
    }
  }
  return [...refs].sort();
}

/** Detect an HTML error/fallback page accidentally saved under a .js, .mjs, or .css filename. */
export function looksLikeHtmlAsset(relPath, buf) {
  if (!/\.(?:m?js|css)$/i.test(relPath)) return false;
  const head = buf.subarray(0, 256).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

/** Recursively walk dir, rejecting any symlink. Returns sorted relative POSIX paths. */
function walkRegularFiles(rootDir, errors, sub = "") {
  const out = [];
  const current = sub ? path.join(rootDir, sub) : rootDir;
  const entries = readdirSync(current).sort();
  for (const name of entries) {
    const abs = path.join(current, name);
    const rel = sub ? `${sub}/${name}` : name;
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      errors.push(`symlink rejected in deployable package: ${rel}`);
      continue;
    }
    if (st.isDirectory()) {
      out.push(...walkRegularFiles(rootDir, errors, rel));
    } else if (st.isFile()) {
      out.push(toPosix(rel));
    } else {
      errors.push(`unsupported non-regular file in deployable package: ${rel}`);
    }
  }
  return out;
}

function checkAssetsIgnore(raw, errors) {
  const lines = new Set(
    raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );
  for (const req of REQUIRED_ASSETS_IGNORE) {
    if (!lines.has(req)) errors.push(`.assetsignore must exclude ${req}`);
  }
}

/**
 * Seal a freshly built Worker package and write the seal file outside workerDir.
 */
export function sealWorkerRelease({
  workerDir,
  sealPath,
  release,
  profile = "default",
  htmlShells = [],
}) {
  const resolvedDir = path.resolve(workerDir);
  const resolvedSeal = path.resolve(sealPath);
  if (resolvedSeal === resolvedDir || resolvedSeal.startsWith(resolvedDir + path.sep)) {
    throw new Error("sealPath must be outside workerDir so it is never uploaded as a public asset");
  }

  const errors = [];
  const relFiles = walkRegularFiles(resolvedDir, errors);
  if (errors.length) throw new Error(`Cannot seal worker package:\n- ${errors.join("\n- ")}`);

  const readRequired = (name) => {
    const abs = path.join(resolvedDir, name);
    if (!existsSync(abs)) throw new Error(`Missing required build file: ${name}`);
    const buf = readFileSync(abs);
    return { path: name, sha256: sha256Buffer(buf), bytes: buf.byteLength, buf };
  };

  const worker = readRequired("_worker.js");
  const headers = readRequired("_headers");
  const assetsIgnore = readRequired(".assetsignore");
  checkAssetsIgnore(assetsIgnore.buf.toString("utf8"), errors);

  const files = {};
  for (const rel of relFiles) {
    if (EXCLUDED_PUBLIC_FILES.has(rel)) continue;
    if (FORBIDDEN_PUBLIC_FILES.has(rel)) {
      errors.push(`forbidden public file present at seal time: ${rel}`);
      continue;
    }
    if (rel.endsWith(".map")) {
      errors.push(`browser source map must not be in deployable assets: ${rel}`);
      continue;
    }
    const buf = readFileSync(path.join(resolvedDir, rel));
    if (looksLikeHtmlAsset(rel, buf)) {
      errors.push(`HTML content saved under script/style path: ${rel}`);
      continue;
    }
    files[rel] = {
      sha256: sha256Buffer(buf),
      bytes: buf.byteLength,
      immutable: rel.startsWith("assets/"),
    };
  }

  const bootReferences = extractBootReferences(htmlShells);
  for (const ref of bootReferences) {
    if (!files[ref]) {
      errors.push(`boot asset referenced by embedded HTML is missing: ${ref}`);
    }
  }

  if (errors.length) throw new Error(`Cannot seal worker package:\n- ${errors.join("\n- ")}`);

  const seal = {
    version: 1,
    release: String(release || "dev"),
    profile: String(profile || "default"),
    sealedAt: new Date().toISOString(),
    worker: { path: worker.path, sha256: worker.sha256, bytes: worker.bytes },
    headers: { path: headers.path, sha256: headers.sha256, bytes: headers.bytes },
    assetsIgnore: { path: assetsIgnore.path, sha256: assetsIgnore.sha256, bytes: assetsIgnore.bytes },
    bootReferences,
    files,
  };

  writeFileSync(resolvedSeal, JSON.stringify(seal, null, 2) + "\n");
  return seal;
}

/**
 * Verify a built Worker package against its seal (and optionally against a previous release seal).
 */
export function verifyWorkerRelease({
  workerDir,
  sealPath,
  expectedRelease,
  previousSealPath,
}) {
  const errors = [];
  const resolvedDir = path.resolve(workerDir);
  const resolvedSeal = path.resolve(sealPath);

  if (!existsSync(resolvedDir)) {
    return { ok: false, errors: [`worker directory missing: ${resolvedDir}`], summary: null };
  }
  if (!existsSync(resolvedSeal)) {
    return { ok: false, errors: [`worker release seal missing: ${resolvedSeal}`], summary: null };
  }
  if (resolvedSeal === resolvedDir || resolvedSeal.startsWith(resolvedDir + path.sep)) {
    errors.push("seal file must live outside workerDir");
  }

  let seal;
  try {
    seal = JSON.parse(readFileSync(resolvedSeal, "utf8"));
  } catch (err) {
    return { ok: false, errors: [`invalid seal JSON: ${err.message}`], summary: null };
  }

  if (seal?.version !== 1 || !seal.worker || !seal.headers || !seal.assetsIgnore || !seal.files) {
    return { ok: false, errors: ["seal manifest has invalid format or unsupported version"], summary: null };
  }
  if (expectedRelease && seal.release !== expectedRelease) {
    errors.push(`seal release mismatch: expected "${expectedRelease}", got "${seal.release}"`);
  }

  let previousSeal = null;
  if (previousSealPath) {
    const resolvedPrev = path.resolve(previousSealPath);
    if (!existsSync(resolvedPrev)) {
      errors.push(`previous release seal missing: ${resolvedPrev}`);
    } else {
      try {
        previousSeal = JSON.parse(readFileSync(resolvedPrev, "utf8"));
        if (previousSeal?.version !== 1 || !previousSeal.files) {
          errors.push("previous release seal has invalid format");
          previousSeal = null;
        }
      } catch (err) {
        errors.push(`invalid previous seal JSON: ${err.message}`);
      }
    }
  }

  const relFiles = walkRegularFiles(resolvedDir, errors);
  const presentSet = new Set(relFiles);

  const verifyCore = (label, meta) => {
    const abs = path.join(resolvedDir, meta.path);
    if (!presentSet.has(meta.path)) {
      errors.push(`sealed ${label} missing: ${meta.path}`);
      return null;
    }
    const buf = readFileSync(abs);
    const actualSha = sha256Buffer(buf);
    if (actualSha !== meta.sha256 || buf.byteLength !== meta.bytes) {
      errors.push(`sealed ${label} hash mismatch (${meta.path}): expected ${meta.sha256}, got ${actualSha}`);
    }
    return buf;
  };

  const workerBuf = verifyCore("worker bundle", seal.worker);
  verifyCore("headers file", seal.headers);
  const ignoreBuf = verifyCore("assetsignore file", seal.assetsIgnore);
  if (ignoreBuf) checkAssetsIgnore(ignoreBuf.toString("utf8"), errors);

  const sealedPaths = Object.keys(seal.files);
  for (const rel of sealedPaths) {
    const expected = seal.files[rel];
    if (!presentSet.has(rel)) {
      errors.push(`sealed asset missing: ${rel}`);
      continue;
    }
    const buf = readFileSync(path.join(resolvedDir, rel));
    const actualSha = sha256Buffer(buf);
    if (actualSha !== expected.sha256 || buf.byteLength !== expected.bytes) {
      errors.push(`sealed asset modified (${rel}): expected ${expected.sha256}, got ${actualSha}`);
    }
    if (looksLikeHtmlAsset(rel, buf)) {
      errors.push(`HTML content saved under script/style path: ${rel}`);
    }
  }

  const workerText = workerBuf ? workerBuf.toString("utf8") : "";
  for (const ref of seal.bootReferences || []) {
    if (!seal.files[ref]) errors.push(`boot reference not sealed: ${ref}`);
    if (!presentSet.has(ref)) errors.push(`boot asset missing from package: ${ref}`);
    const fileName = ref.replace(/^assets\//, "");
    if (workerText && !workerText.includes(fileName)) {
      errors.push(`worker bundle does not reference sealed boot asset: ${ref}`);
    }
  }

  const prevImmutable = new Map();
  if (previousSeal) {
    for (const [rel, meta] of Object.entries(previousSeal.files)) {
      if (meta.immutable && rel.startsWith("assets/")) {
        prevImmutable.set(rel, meta);
      }
    }
  }

  let carriedCount = 0;
  let sharedImmutableCount = 0;
  for (const rel of relFiles) {
    if (EXCLUDED_PUBLIC_FILES.has(rel)) continue;
    if (FORBIDDEN_PUBLIC_FILES.has(rel)) {
      errors.push(`forbidden public file present: ${rel}`);
      continue;
    }
    if (rel.endsWith(".map")) {
      errors.push(`browser source map must not be deployed publicly: ${rel}`);
      continue;
    }
    if (seal.files[rel]) {
      if (prevImmutable.has(rel)) sharedImmutableCount++;
      continue;
    }

    if (!rel.startsWith("assets/")) {
      errors.push(`unexpected static path outside assets/: ${rel}`);
      continue;
    }
    const baseName = rel.slice("assets/".length);
    if (baseName.includes("/") || !SAFE_ASSET_NAME.test(baseName)) {
      errors.push(`unexpected asset path: ${rel}`);
      continue;
    }
    const buf = readFileSync(path.join(resolvedDir, rel));
    if (looksLikeHtmlAsset(rel, buf)) {
      errors.push(`carried asset is an HTML fallback page, not JS/CSS: ${rel}`);
      continue;
    }
    if (previousSeal) {
      const prevMeta = prevImmutable.get(rel);
      if (!prevMeta) {
        errors.push(`unexpected extra asset not in current or previous seal: ${rel}`);
        continue;
      }
      const actualSha = sha256Buffer(buf);
      if (actualSha !== prevMeta.sha256 || buf.byteLength !== prevMeta.bytes) {
        errors.push(`carried previous asset hash mismatch (${rel}): expected ${prevMeta.sha256}, got ${actualSha}`);
        continue;
      }
    }
    carriedCount++;
  }

  if (previousSeal) {
    for (const [rel, prevMeta] of prevImmutable.entries()) {
      if (!presentSet.has(rel)) {
        errors.push(`previous release immutable asset missing (breaks two-stage continuity): ${rel}`);
        continue;
      }
      const buf = readFileSync(path.join(resolvedDir, rel));
      const actualSha = sha256Buffer(buf);
      if (actualSha !== prevMeta.sha256 || buf.byteLength !== prevMeta.bytes) {
        errors.push(`previous release asset hash changed (${rel}): expected ${prevMeta.sha256}, got ${actualSha}`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      release: seal.release,
      sealedFiles: sealedPaths.length,
      bootReferences: (seal.bootReferences || []).length,
      carriedPreviousAssets: carriedCount,
      sharedImmutableAssets: sharedImmutableCount,
    },
  };
}

function parseArgs(argv) {
  const opts = {
    workerDir: "dist/worker",
    sealPath: "dist/worker-release.json",
    expectedRelease: undefined,
    previousSealPath: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir" && argv[i + 1]) opts.workerDir = argv[++i];
    else if (a === "--seal" && argv[i + 1]) opts.sealPath = argv[++i];
    else if (a === "--release" && argv[i + 1]) opts.expectedRelease = argv[++i];
    else if (a === "--previous" && argv[i + 1]) opts.previousSealPath = argv[++i];
    else if (a === "--") continue;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const res = verifyWorkerRelease(opts);
    if (!res.ok) {
      console.error("worker release verification FAILED:");
      for (const e of res.errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    const s = res.summary;
    console.log(
      `worker release verified: release=${s.release}, sealed=${s.sealedFiles}, boot=${s.bootReferences}, carried=${s.carriedPreviousAssets}, shared=${s.sharedImmutableAssets}`,
    );
  } catch (err) {
    console.error(`worker release verification error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
