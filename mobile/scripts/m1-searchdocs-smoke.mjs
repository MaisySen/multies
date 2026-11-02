#!/usr/bin/env node
/**
 * M1 searchdocs contract smoke against STAGING (preview.multies.si). Calls every route the phone's Search and Docs
 * screens call, the way the phone does (cookie session, origin header), as the QA admin, the QA member and with no
 * session (what a project guest or client portal visitor has on these routes), and runs the phone's own parsers over
 * the real answers. Read only, except one comment and one share link on a QA doc, both removed at once.
 *
 * Run: tsx scripts/m1-searchdocs-smoke.mjs   (CHECKHDR=<file from app/scripts/check-header.mjs>)
 * Never prints a secret: session files and the check header are read from disk and only sent as headers.
 */
import fs from "node:fs";
import { cleanQuery, phoneTarget, searchPath } from "../src/lib/global-search.ts";
import { docBlocks, treeRows } from "../src/lib/docs.ts";

const BASE = process.env.BASE || "https://preview.multies.si";
const check = process.env.CHECKHDR ? fs.readFileSync(process.env.CHECKHDR, "utf8").trim() : "";
const read = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const roles = {
  admin: read("/home/user/.multies-secrets/staging-test-session.json"),
  member: read("/home/user/.multies-secrets/verify/staging-member-session.json"),
  none: { cookie_name: null },
};
const results = [];
const ok = (role, what, pass, note = "") => { results.push({ role, what, pass, note }); console.log(`${pass ? "PASS" : "FAIL"} ${role} ${what}${note ? ` (${note})` : ""}`); };

async function call(role, method, path, body) {
  const s = roles[role];
  const headers = { accept: "application/json", origin: BASE };
  if (check) headers["x-multies-check"] = check;
  if (s?.cookie_name) headers.cookie = `${s.cookie_name}=${s.cookie_value}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(`${BASE}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, json };
}

const isGroup = (g) => g && typeof g.type === "string" && typeof g.label === "string" && Array.isArray(g.items) && g.items.every((i) => typeof i.id === "string" && typeof i.title === "string" && typeof i.url === "string");

for (const role of ["admin", "member"]) {
  if (!roles[role]) { ok(role, "session file", false, "missing"); continue; }
  const cfg = await call(role, "GET", "/config");
  ok(role, "GET /config", cfg.status === 200 && typeof cfg.json === "object", `docsPlus=${cfg.json?.docsPlus} searchR98=${cfg.json?.searchR98}`);
  const docsPlus = !!cfg.json?.docsPlus;

  for (const [label, raw, choice] of [["short", "test", "all"], ["typo", "tset", "all"], ["contacts chip", "qa", "contacts"], ["69 chars", "a".repeat(69), "all"], ["long paste", `quarter plan ${"lorem ipsum ".repeat(40)}`, "all"]]) {
    const q = cleanQuery(raw);
    const r = await call(role, "GET", searchPath(q, choice));
    const shapeOk = r.status === 200 && Array.isArray(r.json?.groups) && r.json.groups.every(isGroup);
    const targets = shapeOk ? r.json.groups.flatMap((g) => g.items.map((i) => phoneTarget(i).kind)) : [];
    ok(role, `GET /search ${label}`, shapeOk, `${r.status}, q ${q.length} chars, groups ${shapeOk ? r.json.groups.map((g) => `${g.type}:${g.items.length}`).join(" ") || "none" : "?"}, phone screens ${targets.filter((k) => k === "screen").length}/${targets.length}`);
  }

  const tree = await call(role, "GET", "/docs/tree");
  const treeOk = tree.status === 200 && Array.isArray(tree.json?.tree);
  const rows = treeOk ? treeRows(tree.json.tree, { query: "" }) : [];
  ok(role, "GET /docs/tree", treeOk, `${tree.status}, ${tree.json?.count ?? "?"} pages, ${rows.length} top rows`);
  const first = treeOk ? (function find(ns) { for (const n of ns) { if (n.kind !== "whiteboard") return n; const k = find(n.children ?? []); if (k) return k; } return null; })(tree.json.tree) : null;
  if (!first) { ok(role, "a doc to read", false, "no doc in the tree"); continue; }
  const doc = await call(role, "GET", `/docs/${encodeURIComponent(first.id)}`);
  let blocks = [];
  try { blocks = docBlocks(doc.json?.doc?.content); } catch (e) { ok(role, "docBlocks", false, String(e)); }
  ok(role, "GET /docs/:id + phone reader", doc.status === 200 && !!doc.json?.doc?.content, `${doc.status}, ${blocks.length} blocks: ${[...new Set(blocks.map((b) => b.t))].join(",")}`);
  const gone = await call(role, "GET", "/docs/doc_does_not_exist");
  ok(role, "GET /docs/:missing is a plain 404", gone.status === 404);

  if (docsPlus) {
    const c = await call(role, "GET", `/docs-plus/docs/${encodeURIComponent(first.id)}/comments`);
    ok(role, "GET comments", c.status === 200 && Array.isArray(c.json?.team) && typeof c.json?.canModerate === "boolean", `${c.status}, team ${c.json?.team?.length}, canModerate ${c.json?.canModerate}`);
    if (role === "admin") {
      const add = await call(role, "POST", `/docs-plus/docs/${encodeURIComponent(first.id)}/comments`, { body: "M1 phone smoke test comment", thread: "team" });
      const cid = add.json?.comment?.id;
      ok(role, "POST comment (own)", add.status === 201 && add.json?.comment?.mine === true && add.json?.comment?.canEdit === true, `${add.status}`);
      if (cid) {
        const ed = await call(role, "PATCH", `/docs-plus/comments/${cid}`, { body: "M1 phone smoke test comment, edited" });
        ok(role, "PATCH comment body (own)", ed.status === 200 && !!ed.json?.comment?.editedAt, `${ed.status}`);
        const del = await call(role, "DELETE", `/docs-plus/comments/${cid}`);
        ok(role, "DELETE comment (own), cleaned up", del.status === 200 && del.json?.ok === true, `${del.status}`);
      }
    }
  }
  const links = await call(role, "GET", `/share-links?kind=doc&targetId=${encodeURIComponent(first.id)}`);
  ok(role, "GET share links", links.status === 200 && Array.isArray(links.json?.links) && typeof links.json?.allowShareLinks === "boolean", `${links.status}, ${links.json?.links?.length} active, allowed ${links.json?.allowShareLinks}`);
  if (role === "admin" && links.json?.allowShareLinks) {
    const mk = await call(role, "POST", "/share-links", { kind: "doc", targetId: first.id, expiresInDays: 7, showWorkspaceName: true });
    const lid = mk.json?.link?.id;
    ok(role, "POST share link", mk.status === 201 && typeof mk.json?.link?.url === "string" && !!lid, `${mk.status}, url ${mk.json?.link?.url ? "returned once" : "missing"}`);
    if (lid) {
      const off = await call(role, "DELETE", `/share-links/${lid}`);
      ok(role, "DELETE share link (turned off), cleaned up", off.status === 200, `${off.status}`);
    }
  }
}

// No session: what a project guest or client portal visitor has on these member routes (their own cookie is not a member session).
for (const path of ["/search?q=test&limit=5", "/docs/tree", "/share-links?kind=doc&targetId=x", "/docs-plus/docs/x/comments"]) {
  const r = await call("none", "GET", path);
  ok("no session", `GET ${path.split("?")[0]}`, r.status === 401 || r.status === 404, `${r.status}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
fs.writeFileSync(process.env.OUT || "/tmp/m1-searchdocs-smoke.json", JSON.stringify({ at: new Date().toISOString(), base: BASE, results }, null, 1));
process.exit(failed.length ? 1 : 0);
