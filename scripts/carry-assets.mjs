#!/usr/bin/env node
/**
 * R58: keep the previous release's static files after a deploy, so a tab opened before the deploy can still load
 * its lazy chunks (otherwise /assets/<old hash>.js answers 404 and the page breaks; R56b reloads once as a fallback).
 *
 * Before `wrangler deploy`, this walks the release that is live now, from its index.html through every file under
 * /assets/ that its scripts and styles name, and copies each one the new build does not have into dist/worker/assets.
 * Only the live release's own files are carried (one release back), so the folder does not grow from deploy to deploy.
 * Asset uploads are by content hash, so files the host already holds cost no upload.
 *
 * usage: node scripts/carry-assets.mjs <live base url> [assets dir, default dist/worker/assets]
 * Never fails the deploy: on any problem it says so and exits 0 having carried what it could.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const base = (process.argv[2] ?? "").replace(/\/+$/, "");
const dir = process.argv[3] ?? "dist/worker/assets";
const MAX_FILES = 1500;
const MAX_BYTES = 60 * 1024 * 1024;
const NAME = /^[A-Za-z0-9_.-]+$/;

/** Every /assets/ file a text names: "assets/x.js" (vite's preload map, index.html), "./x.js" inside a chunk, url(x.woff2) in css. */
export function referenced(text, fromAsset) {
  const out = new Set();
  for (const m of text.matchAll(/(?:^|["'(\s=,])\/?assets\/([A-Za-z0-9_.-]+\.[a-z0-9]{1,6})/g)) out.add(m[1]);
  if (fromAsset) {
    for (const m of text.matchAll(/["'(]\.\/([A-Za-z0-9_.-]+\.(?:js|mjs|css|woff2?|ttf|svg|png|jpe?g|webp|avif|gif|wasm))["')]/g)) out.add(m[1]);
    for (const m of text.matchAll(/url\(\s*["']?(?:\.\/)?([A-Za-z0-9_.-]+\.(?:woff2?|ttf|svg|png|jpe?g|webp|avif|gif))["']?\s*\)/g)) out.add(m[1]);
  }
  return [...out].filter((n) => NAME.test(n));
}

async function get(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { "user-agent": "multies-deploy-carry" } });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } finally { clearTimeout(t); }
}

async function main() {
  if (!/^https:\/\//.test(base)) { console.log("carry-assets: no live https base url given, nothing carried"); return; }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const index = await get(`${base}/`);
  if (!index) { console.log("carry-assets: live index not readable, nothing carried"); return; }
  const queue = referenced(new TextDecoder().decode(index), false);
  const seen = new Set(queue);
  let carried = 0, present = 0, missing = 0, bytes = 0;
  while (queue.length && seen.size <= MAX_FILES && bytes <= MAX_BYTES) {
    const name = queue.shift();
    const body = await get(`${base}/assets/${name}`).catch(() => null);
    if (!body) { missing++; continue; }
    const target = path.join(dir, name);
    if (existsSync(target)) present++;
    else { writeFileSync(target, body); carried++; bytes += body.byteLength; }
    if (/\.(m?js|css)$/.test(name)) {
      for (const n of referenced(new TextDecoder().decode(body), true)) if (!seen.has(n)) { seen.add(n); queue.push(n); }
    }
  }
  console.log(`carry-assets: live files ${seen.size}, already in this build ${present}, carried ${carried} (${Math.round(bytes / 1024)} KB), unreadable ${missing}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => console.log(`carry-assets: stopped early (${err?.message ?? err}); the deploy goes on`));
}
