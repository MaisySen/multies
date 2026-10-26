#!/usr/bin/env node
/**
 * Security headers grade, in the style of securityheaders.com (R30).
 *
 *   npm run security:headers                       # http://localhost:8788
 *   npm run security:headers -- https://multies.si # read only: a handful of GETs
 *   node scripts/security-headers-grade.mjs <base> --json
 *
 * Graded headers: Content-Security-Policy, Strict-Transport-Security, X-Frame-Options (or CSP
 * frame-ancestors), X-Content-Type-Options, Referrer-Policy, Permissions-Policy. Grade: every one
 * present and no 'unsafe-inline' or 'unsafe-eval' in script-src gives A+; all present with an unsafe
 * script-src gives A; then B, C, D, E, F for 1 to 5 or more missing. Over plain http HSTS cannot be
 * sent, so a localhost base counts it as not applicable (the line says so). Extra notes (not graded):
 * HSTS preload, COOP, CORP, wildcard sources, cookie flags.
 */
const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith("--")) ?? "http://localhost:8788").replace(/\/+$/, "");
const asJson = args.includes("--json");
const PATHS = ["/", "/login", "/app/inbox", "/s/not-a-real-share", "/api/health", "/api/config", "/api/v1/reference", "/favicon.svg"];

export function parseCsp(csp) {
  const out = {};
  for (const part of (csp ?? "").split(";")) {
    const [name, ...vals] = part.trim().split(/\s+/);
    if (name) out[name.toLowerCase()] = vals;
  }
  return out;
}

export function gradeHeaders(headers, { https }) {
  const get = (k) => headers.get(k);
  const csp = get("content-security-policy");
  const d = parseCsp(csp);
  const missing = [];
  const notes = [];
  if (!csp) missing.push("Content-Security-Policy");
  const hsts = get("strict-transport-security");
  if (https && !hsts) missing.push("Strict-Transport-Security");
  if (!get("x-frame-options") && !d["frame-ancestors"]) missing.push("X-Frame-Options");
  if ((get("x-content-type-options") ?? "").toLowerCase() !== "nosniff") missing.push("X-Content-Type-Options");
  if (!get("referrer-policy")) missing.push("Referrer-Policy");
  if (!get("permissions-policy")) missing.push("Permissions-Policy");
  const script = d["script-src"] ?? d["default-src"] ?? [];
  const unsafeScript = csp ? script.filter((v) => v === "'unsafe-inline'" || v === "'unsafe-eval'") : [];
  // A nonce or hash makes browsers ignore 'unsafe-inline' (it is only a fallback for old ones).
  const neutralised = unsafeScript.length && script.some((v) => /^'(nonce|sha256|sha384|sha512)-/.test(v)) && !unsafeScript.includes("'unsafe-eval'");
  if (unsafeScript.length && !neutralised) notes.push(`script-src has ${unsafeScript.join(" ")}`);
  if (!https) notes.push("HSTS not applicable over plain http");
  else if (hsts) {
    const age = Number(/max-age=(\d+)/i.exec(hsts)?.[1] ?? 0);
    const preload = age >= 31536000 && /includesubdomains/i.test(hsts) && /preload/i.test(hsts);
    if (!preload) notes.push("HSTS not preload eligible (needs max-age>=31536000; includeSubDomains; preload)");
  }
  if (csp && !d["object-src"] && !(d["default-src"] ?? []).includes("'none'")) notes.push("CSP has no object-src");
  if (csp && !d["base-uri"]) notes.push("CSP has no base-uri");
  for (const [k, v] of Object.entries(d)) for (const s of v) if (/^(https?|wss?):$/.test(s) && k !== "img-src") notes.push(`${k} allows any ${s} source`);
  if ((d["style-src"] ?? []).includes("'unsafe-inline'")) notes.push("style-src keeps 'unsafe-inline'");
  if (!get("cross-origin-opener-policy")) notes.push("no Cross-Origin-Opener-Policy");
  if (!get("cross-origin-resource-policy")) notes.push("no Cross-Origin-Resource-Policy");
  const cookies = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  for (const c of cookies) {
    const name = c.split("=")[0];
    const flags = c.toLowerCase();
    if (https && !flags.includes("; secure")) notes.push(`cookie ${name} not Secure`);
    if (!flags.includes("httponly")) notes.push(`cookie ${name} not HttpOnly`);
    if (!flags.includes("samesite")) notes.push(`cookie ${name} has no SameSite`);
  }
  const letters = ["A", "B", "C", "D", "E", "F"];
  let grade = letters[Math.min(missing.length, 5)];
  if (grade === "A" && !(unsafeScript.length && !neutralised)) grade = "A+";
  return { grade, missing, notes };
}

async function main() {
  const https = base.startsWith("https://");
  const rows = [];
  for (const p of PATHS) {
    try {
      const res = await fetch(base + p, { redirect: "manual", headers: { accept: p.startsWith("/api/") && p !== "/api/v1/reference" ? "application/json" : "text/html" }, signal: AbortSignal.timeout(15_000) });
      rows.push({ path: p, status: res.status, ...gradeHeaders(res.headers, { https }) });
      await res.arrayBuffer().catch(() => undefined);
    } catch (e) {
      rows.push({ path: p, status: 0, grade: "?", missing: [], notes: [String(e?.message ?? e)] });
    }
  }
  if (asJson) { console.log(JSON.stringify({ base, rows }, null, 2)); return; }
  console.log(`Security headers grade for ${base}`);
  for (const r of rows) {
    console.log(`${r.grade.padEnd(3)} ${String(r.status).padEnd(4)} ${r.path}${r.missing.length ? `  missing: ${r.missing.join(", ")}` : ""}`);
    for (const n of r.notes) console.log(`         note: ${n}`);
  }
  const worst = rows.map((r) => r.grade).sort((a, b) => rank(b) - rank(a))[0];
  console.log(`Overall: ${worst}`);
  if (args.includes("--strict") && worst !== "A+") process.exitCode = 1;
}
function rank(g) { return ["A+", "A", "B", "C", "D", "E", "F", "?"].indexOf(g); }

if (import.meta.url === `file://${process.argv[1]}`) await main();
