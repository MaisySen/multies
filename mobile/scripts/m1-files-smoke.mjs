#!/usr/bin/env node
/**
 * M1 files contract smoke against STAGING (preview.multies.si). Calls every drive route the phone's Files screens call,
 * the way the phone does (cookie session, origin header, raw byte uploads with x-multies-upload: 1), as the QA admin, the
 * QA member and with no session (what a project guest or client portal visitor has), and runs the phone's own parsers
 * over the real answers. Writes only inside a throwaway folder in each tester's own My files, deleted at the end.
 *
 * Run: npx tsx scripts/m1-files-smoke.mjs   (CHECKHDR=<file from app/scripts/check-header.mjs>)
 * Never prints a secret: session files and the check header are read from disk and only sent as headers.
 */
import fs from "node:fs";
import { DRIVE_VIEWS, driveQuery, contentPath, isDriveDetail, isDriveItem, isDriveList, isDriveUsage, uploadPath, versionPath } from "../src/lib/drive.ts";

const BASE = process.env.BASE || "https://preview.multies.si";
const rawCheck = process.env.CHECKHDR ? fs.readFileSync(process.env.CHECKHDR, "utf8").trim() : "";
// The file is a curl header line ("x-multies-check: <value>"); send only the value.
const check = /^x-multies-check:/i.test(rawCheck) ? rawCheck.slice(rawCheck.indexOf(":") + 1).trim() : rawCheck;
const read = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const roles = {
  admin: read("/home/user/.multies-secrets/staging-test-session.json"),
  member: read("/home/user/.multies-secrets/verify/staging-member-session.json"),
  none: { cookie_name: null },
};
const results = [];
const ok = (role, what, pass, note = "") => { results.push({ role, what, pass, note }); console.log(`${pass ? "PASS" : "FAIL"} ${role} ${what}${note ? ` (${note})` : ""}`); };

function headers(role, extra = {}) {
  const s = roles[role];
  const h = { accept: "application/json", origin: BASE, ...extra };
  if (check) h["x-multies-check"] = check;
  if (s?.cookie_name) h.cookie = `${s.cookie_name}=${s.cookie_value}`;
  return h;
}
async function call(role, method, path, body) {
  const h = headers(role, body !== undefined ? { "content-type": "application/json" } : {});
  const r = await fetch(`${BASE}/api${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, json };
}
/** The phone's upload: raw bytes, PUT, x-multies-upload: 1 (what File.upload with BINARY_CONTENT sends). */
async function put(role, path, bytes, type, withFlag = true) {
  const r = await fetch(`${BASE}${path}`, { method: "PUT", headers: headers(role, { "content-type": type, ...(withFlag ? { "x-multies-upload": "1" } : {}) }), body: bytes });
  let json = null; try { json = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, json };
}

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, " ");
for (const role of ["admin", "member"]) {
  if (!roles[role]) { ok(role, "session file", false, "missing"); continue; }
  const cfg = await call(role, "GET", "/config");
  ok(role, "GET /config", cfg.status === 200, `filesPlus=${cfg.json?.filesPlus}`);
  if (!cfg.json?.filesPlus) continue;
  for (const v of DRIVE_VIEWS) {
    const l = await call(role, "GET", `/drive/list?view=${v}`);
    ok(role, `GET /drive/list ${v}`, l.status === 200 && isDriveList(l.json), `${l.status}, ${l.json?.items?.length ?? "?"} items, canAdd ${l.json?.canAdd}`);
  }
  // The phone cuts long searches (lib/drive.ts driveQuery); the raw long one is the web's own limit, recorded only.
  for (const [label, raw] of [["150 chars", "a".repeat(150)], ["unicode", "é".repeat(60)], ["wildcards", "%_!".repeat(30)]]) {
    const s = await call(role, "GET", "/drive/list?view=team&q=" + encodeURIComponent(driveQuery(raw)));
    ok(role, `GET /drive/list long search, phone cut (${label})`, s.status === 200 && isDriveList(s.json), `${s.status}, ${driveQuery(raw).length} chars`);
  }
  const raw = await call(role, "GET", "/drive/list?view=team&q=" + encodeURIComponent("a".repeat(60)));
  console.log(`NOTE ${role} server with an uncut 60 char search answers ${raw.status} (web side limit; the phone never sends it)`);
  const u = await call(role, "GET", "/drive/usage");
  ok(role, "GET /drive/usage", u.status === 200 && isDriveUsage(u.json), `${u.status}, ${u.json?.usedBytes} of ${u.json?.quotaBytes}`);
  const t = await call(role, "GET", "/drive/tags");
  ok(role, "GET /drive/tags", t.status === 200 && Array.isArray(t.json?.tags), String(t.status));

  // A throwaway folder in this tester's own My files.
  const f = await call(role, "POST", "/drive/folders", { space: "private", parentId: null, name: `M1 phone smoke ${stamp}` });
  ok(role, "POST /drive/folders", f.status === 200 && isDriveItem(f.json?.item), String(f.status));
  const folder = f.json?.item?.id;
  if (!folder) continue;
  const text = new TextEncoder().encode("Phone smoke, version 1.\n");
  const up = await put(role, uploadPath({ space: "private", parentId: folder }, "Phone smoke.txt"), text, "text/plain");
  ok(role, "PUT /drive/upload (raw bytes)", up.status === 200 && isDriveItem(up.json?.item), `${up.status}, ${up.json?.item?.sizeBytes} bytes`);
  const id = up.json?.item?.id;
  const noFlag = await put(role, uploadPath({ space: "private", parentId: folder }, "x.txt"), text, "text/plain", false);
  ok(role, "upload without x-multies-upload refused", noFlag.status === 400 || noFlag.status === 403, `${noFlag.status} "${noFlag.json?.error?.message ?? ""}"`);
  if (id) {
    const d = await call(role, "GET", `/drive/items/${id}`);
    ok(role, "GET /drive/items/:id", d.status === 200 && isDriveDetail(d.json), `${d.status}, ${d.json?.versions?.length} versions`);
    const v2 = await put(role, versionPath(id), new TextEncoder().encode("Phone smoke, version 2, longer.\n"), "text/plain");
    ok(role, "PUT /drive/items/:id/content (new version)", v2.status === 200 && isDriveDetail(v2.json) && v2.json.versions.length === 2, `${v2.status}, ${v2.json?.versions?.length} versions`);
    const first = v2.json?.versions?.find((x) => x.number === 1);
    if (first) {
      const rv = await call(role, "POST", `/drive/items/${id}/versions/${first.id}/restore`, {});
      ok(role, "POST restore version", rv.status === 200 && isDriveDetail(rv.json) && rv.json.versions[0]?.current === true && rv.json.item.sizeBytes === text.length, `${rv.status}, note "${rv.json?.versions?.[0]?.note}"`);
    }
    const bytes = await fetch(`${BASE}${contentPath(id)}`, { headers: headers(role) });
    const body = new Uint8Array(await bytes.arrayBuffer());
    ok(role, "GET content (download)", bytes.status === 200 && body.length === text.length, `${bytes.status}, ${body.length} bytes, ${bytes.headers.get("content-disposition")?.split(";")[0]}`);
    const inline = await fetch(`${BASE}${contentPath(id, { inline: true })}`, { headers: headers(role) });
    ok(role, "GET content inline", inline.status === 200, `${inline.status}, ${inline.headers.get("content-type")}`);
    const rn = await call(role, "PATCH", `/drive/items/${id}`, { name: "Phone smoke renamed.txt", note: "From the phone smoke" });
    ok(role, "PATCH rename and note", rn.status === 200 && rn.json?.item?.name === "Phone smoke renamed.txt" && rn.json?.item?.note === "From the phone smoke", String(rn.status));
    const empty = await call(role, "PATCH", `/drive/items/${id}`, { name: " / " });
    ok(role, "PATCH empty name refused with words", empty.status === 422, `"${empty.json?.error?.message ?? ""}"`);
    const st = await call(role, "POST", "/drive/star", { ids: [id], on: true });
    const starred = await call(role, "GET", "/drive/list?view=starred");
    ok(role, "POST /drive/star + Starred view", st.status === 200 && !!starred.json?.items?.some((i) => i.id === id), String(st.status));
    await call(role, "POST", "/drive/star", { ids: [id], on: false });
    const mv = await call(role, "POST", "/drive/move", { ids: [id], parentId: null, space: "private" });
    const back = await call(role, "POST", "/drive/move", { ids: [id], parentId: folder, space: "private" });
    ok(role, "POST /drive/move out and back", mv.status === 200 && mv.json?.moved === 1 && back.status === 200, `${mv.status}/${back.status}`);
    const inFolder = await call(role, "GET", `/drive/list?view=mine&folder=${folder}`);
    ok(role, "folder list with path", inFolder.status === 200 && isDriveList(inFolder.json) && inFolder.json.path.length === 2 && inFolder.json.items.some((i) => i.id === id), `path ${inFolder.json?.path?.map((p) => p.name).join(" > ")}`);
  }
  const tr = await call(role, "POST", "/drive/trash", { ids: [folder] });
  const trash = await call(role, "GET", "/drive/list?view=trash");
  ok(role, "POST /drive/trash + Trash view", tr.status === 200 && !!trash.json?.items?.some((i) => i.id === folder), String(tr.status));
  const rs = await call(role, "POST", "/drive/restore", { ids: [folder] });
  ok(role, "POST /drive/restore", rs.status === 200 && rs.json?.restored >= 1, String(rs.status));
  // Clean up: trash and delete for good (the tester owns this folder).
  await call(role, "POST", "/drive/trash", { ids: [folder] });
  const del = await call(role, "POST", "/drive/delete", { ids: [folder] });
  ok(role, "cleanup (deleted for good)", del.status === 200, String(del.status));

  const brand = await call(role, "POST", "/drive/folders", { space: "brand", parentId: null, name: `M1 brand check ${stamp}` });
  if (role === "member") ok(role, "member cannot change the brand library", brand.status === 403, `${brand.status} "${brand.json?.error?.message ?? ""}"`);
  else {
    ok(role, "admin can add to the brand library", brand.status === 200, String(brand.status));
    if (brand.json?.item?.id) { await call(role, "POST", "/drive/trash", { ids: [brand.json.item.id] }); await call(role, "POST", "/drive/delete", { ids: [brand.json.item.id] }); }
  }
}

for (const path of ["/drive/list?view=team", "/drive/usage", "/drive/tags"]) {
  const r = await call("none", "GET", path);
  ok("none", `GET ${path} refused without a workspace session`, r.status === 401 || r.status === 403, String(r.status));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
fs.mkdirSync("/home/user/tab/files/catalogue/verify/m1/files", { recursive: true });
fs.writeFileSync("/home/user/tab/files/catalogue/verify/m1/files/smoke.json", JSON.stringify({ at: new Date().toISOString(), base: BASE, results }, null, 1));
process.exit(failed.length ? 1 : 0);
