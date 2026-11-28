import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sealWorkerRelease, verifyWorkerRelease } from "../scripts/verify-worker-release.mjs";

const dirs: string[] = [];

function makePackage(release = "rel-001", jsName = "app-aaa111.js", cssName = "app-aaa111.css") {
  const root = mkdtempSync(path.join(tmpdir(), "multies-release-guard-"));
  dirs.push(root);
  const workerDir = path.join(root, "worker");
  const assetsDir = path.join(workerDir, "assets");
  const sealPath = path.join(root, "worker-release.json");
  mkdirSync(assetsDir, { recursive: true });

  const shellHtml = `<!doctype html><html><head><link rel="stylesheet" href="/assets/${cssName}"><script type="module" src="/assets/${jsName}"></script></head><body></body></html>`;
  writeFileSync(path.join(assetsDir, jsName), `console.log(${JSON.stringify(release)});`);
  writeFileSync(path.join(assetsDir, cssName), `body { color: #111; }`);
  writeFileSync(path.join(workerDir, "sw.js"), `self.addEventListener("install", () => {});`);
  writeFileSync(path.join(workerDir, "_worker.js"), `const SHELL = ${JSON.stringify(shellHtml)}; export default { fetch() { return new Response(SHELL); } };`);
  writeFileSync(path.join(workerDir, "_headers"), "/*\n  x-content-type-options: nosniff\n");
  writeFileSync(path.join(workerDir, ".assetsignore"), "_worker.js\n_worker.js.map\ntab-site.json\n.assetsignore\n");
  writeFileSync(path.join(workerDir, "tab-site.json"), JSON.stringify({ kind: "worker" }));

  const seal = sealWorkerRelease({ workerDir, sealPath, release, htmlShells: [shellHtml] });
  return { root, workerDir, assetsDir, sealPath, seal, shellHtml };
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("Worker release guard", () => {
  it("passes on a freshly sealed Worker and assets package", () => {
    const pkg = makePackage("rel-100");
    const res = verifyWorkerRelease({ workerDir: pkg.workerDir, sealPath: pkg.sealPath, expectedRelease: "rel-100" });
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.summary).toMatchObject({ release: "rel-100", sealedFiles: 3, bootReferences: 2, carriedPreviousAssets: 0 });
  });

  it("rejects a stale Worker paired with replaced new assets (23 Nov blank-page fault)", () => {
    const pkg = makePackage("rel-100", "app-old111.js", "app-old111.css");
    unlinkSync(path.join(pkg.assetsDir, "app-old111.js"));
    writeFileSync(path.join(pkg.assetsDir, "app-new222.js"), "console.log('new');");
    const res = verifyWorkerRelease({ workerDir: pkg.workerDir, sealPath: pkg.sealPath });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("sealed asset missing: assets/app-old111.js"))).toBe(true);
    expect(res.errors.some((e) => e.includes("boot asset missing from package: assets/app-old111.js"))).toBe(true);
  });

  it("rejects a current Worker with a missing CSS boot asset", () => {
    const pkg = makePackage("rel-101");
    unlinkSync(path.join(pkg.assetsDir, "app-aaa111.css"));
    const res = verifyWorkerRelease({ workerDir: pkg.workerDir, sealPath: pkg.sealPath });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("app-aaa111.css"))).toBe(true);
  });

  it("rejects a modified _worker.js or _headers file", () => {
    const pkg = makePackage("rel-102");
    writeFileSync(path.join(pkg.workerDir, "_worker.js"), "export default { fetch() { return new Response('tampered'); } };");
    writeFileSync(path.join(pkg.workerDir, "_headers"), "/*\n  x-frame-options: ALLOWALL\n");
    const res = verifyWorkerRelease({ workerDir: pkg.workerDir, sealPath: pkg.sealPath });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("sealed worker bundle hash mismatch"))).toBe(true);
    expect(res.errors.some((e) => e.includes("sealed headers file hash mismatch"))).toBe(true);
  });

  it("rejects forbidden public files (index.html) and browser source maps (.map)", () => {
    const pkg = makePackage("rel-103");
    writeFileSync(path.join(pkg.workerDir, "index.html"), "<!doctype html>");
    writeFileSync(path.join(pkg.assetsDir, "app-aaa111.js.map"), "{}");
    const res = verifyWorkerRelease({ workerDir: pkg.workerDir, sealPath: pkg.sealPath });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("forbidden public file present: index.html"))).toBe(true);
    expect(res.errors.some((e) => e.includes("browser source map"))).toBe(true);
  });

  it("rejects an HTML error or fallback page saved as a JS or CSS asset", () => {
    const pkg = makePackage("rel-104");
    writeFileSync(path.join(pkg.assetsDir, "carried-old.js"), "<!DOCTYPE html><html><body>Not found</body></html>");
    const res = verifyWorkerRelease({ workerDir: pkg.workerDir, sealPath: pkg.sealPath });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("HTML fallback page"))).toBe(true);
  });

  it("rejects unexpected static paths outside assets/", () => {
    const pkg = makePackage("rel-105");
    writeFileSync(path.join(pkg.workerDir, "leak.txt"), "secret");
    const res = verifyWorkerRelease({ workerDir: pkg.workerDir, sealPath: pkg.sealPath });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("unexpected static path outside assets/: leak.txt"))).toBe(true);
  });

  it("rejects symlinks inside the deployable directory", () => {
    const pkg = makePackage("rel-106");
    const linkPath = path.join(pkg.assetsDir, "evil-link.js");
    try {
      symlinkSync(path.join(pkg.assetsDir, "app-aaa111.js"), linkPath);
    } catch {
      return;
    }
    const res = verifyWorkerRelease({ workerDir: pkg.workerDir, sealPath: pkg.sealPath });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("symlink rejected"))).toBe(true);
  });

  it("enforces full immutable asset continuity against --previous seal", () => {
    const prev = makePackage("rel-200", "app-old111.js", "shared-000.css");
    const next = makePackage("rel-201", "app-new222.js", "shared-000.css");

    const failMissing = verifyWorkerRelease({
      workerDir: next.workerDir,
      sealPath: next.sealPath,
      expectedRelease: "rel-201",
      previousSealPath: prev.sealPath,
    });
    expect(failMissing.ok).toBe(false);
    expect(failMissing.errors.some((e) => e.includes("previous release immutable asset missing"))).toBe(true);

    writeFileSync(path.join(next.assetsDir, "app-old111.js"), `console.log("rel-200");`);
    const okCarried = verifyWorkerRelease({
      workerDir: next.workerDir,
      sealPath: next.sealPath,
      expectedRelease: "rel-201",
      previousSealPath: prev.sealPath,
    });
    expect(okCarried.ok).toBe(true);
    expect(okCarried.summary).toMatchObject({ carriedPreviousAssets: 1, sharedImmutableAssets: 1 });

    writeFileSync(path.join(next.assetsDir, "app-old111.js"), `console.log("tampered");`);
    const failTampered = verifyWorkerRelease({
      workerDir: next.workerDir,
      sealPath: next.sealPath,
      previousSealPath: prev.sealPath,
    });
    expect(failTampered.ok).toBe(false);
    expect(failTampered.errors.some((e) => e.includes("carried previous asset hash mismatch"))).toBe(true);
  });

  it("rejects release id mismatch when --release is provided", () => {
    const pkg = makePackage("rel-300");
    const res = verifyWorkerRelease({ workerDir: pkg.workerDir, sealPath: pkg.sealPath, expectedRelease: "rel-999" });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("seal release mismatch"))).toBe(true);
  });
});
