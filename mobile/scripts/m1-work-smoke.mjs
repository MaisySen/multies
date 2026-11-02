#!/usr/bin/env node
/**
 * M1 work contract smoke against STAGING (preview.multies.si). Calls every route the phone's Contacts, Visits, Mail merge,
 * Mail archive and Calendar and contacts sync screens call, the way the phone does (cookie session, origin header), as
 * the QA admin, the QA member and with no session (what a project guest or client portal visitor has). Read only, apart
 * from one app password each tester makes for themselves and revokes at once, and Pause or Resume on a newsletter that
 * is not in a state to take it (the server refuses with 400, nothing changes). No test mail is sent.
 *
 * Run: CHECKHDR=<file from app/scripts/check-header.mjs> npx tsx scripts/m1-work-smoke.mjs
 * Never prints a secret: session files and the check header are read from disk and only sent as headers.
 */
import fs from "node:fs";
import { newsletterActions, journeyActions } from "../src/lib/mail-merge.ts";
import { archiveQuery } from "../src/lib/mail-archive.ts";
import { passwordName } from "../src/lib/dav-sync.ts";

const BASE = process.env.BASE || "https://preview.multies.si";
const rawCheck = process.env.CHECKHDR ? fs.readFileSync(process.env.CHECKHDR, "utf8").trim() : "";
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
const msg = (r) => r.json?.error?.message ?? r.json?.message ?? "";
const C = "/tools/campaigns";
/** The phone's contact search cut: whole characters, within 46 bytes once wrapped in %...% (lib/contacts.ts). */
function cut(q) { let out = ""; for (const ch of q.trim().replace(/\s+/g, " ")) { if (Buffer.byteLength(`%${out}${ch}%`) > 48) break; out += ch; } return out; }

for (const role of ["admin", "member"]) {
  if (!roles[role]?.cookie_name) { ok(role, "session file", false, "missing"); continue; }
  const cfg = await call(role, "GET", "/config");
  const merge = !!cfg.json?.tools && Array.isArray(cfg.json?.toolFeatures) && cfg.json.toolFeatures.includes("merge_plus_r109");
  ok(role, "GET /config", cfg.status === 200, `maps=${cfg.json?.maps} merge=${merge} mailArchive=${cfg.json?.mailArchive} davSync=${cfg.json?.davSync}`);

  // Contacts and Visits (part one of this work).
  const cl = await call(role, "GET", "/contacts?limit=100");
  ok(role, "GET /contacts", cl.status === 200 && Array.isArray(cl.json?.contacts), `${cl.status}, ${cl.json?.contacts?.length ?? "?"} contacts`);
  const long = await call(role, "GET", `/contacts?limit=100&q=${encodeURIComponent(cut("harbour build site manager priya raman sydney nsw 2000 australia"))}`);
  ok(role, "GET /contacts long search, phone cut", long.status === 200, String(long.status));
  const first = cl.json?.contacts?.[0];
  if (first) {
    const one = await call(role, "GET", `/contacts/${encodeURIComponent(first.id)}`);
    ok(role, "GET /contacts/:id", one.status === 200 && !!one.json?.contact, String(one.status));
    if (first.companyId) { const co = await call(role, "GET", `/companies/${encodeURIComponent(first.companyId)}`); ok(role, "GET /companies/:id", co.status === 200, String(co.status)); }
    if (cfg.json?.maps) { const pl = await call(role, "GET", `/maps/places?type=contact&id=${encodeURIComponent(first.id)}`); ok(role, "GET /maps/places", pl.status === 200, String(pl.status)); }
  }
  if (cfg.json?.maps) { const v = await call(role, "GET", "/maps/visits"); ok(role, "GET /maps/visits", v.status === 200, String(v.status)); }

  // Mail merge status.
  if (merge) {
    const nl = await call(role, "GET", `${C}/newsletters`);
    ok(role, "GET newsletters", nl.status === 200 && Array.isArray(nl.json?.newsletters), `${nl.status}, ${nl.json?.newsletters?.length ?? "?"}`);
    const ls = await call(role, "GET", `${C}/lists`);
    ok(role, "GET lists", ls.status === 200 && Array.isArray(ls.json?.lists) && (ls.json.lists[0] === undefined || typeof ls.json.lists[0].subscribed === "number"), `${ls.status}, ${ls.json?.lists?.length ?? "?"}`);
    const js = await call(role, "GET", `${C}/journeys`);
    ok(role, "GET journeys", js.status === 200 && Array.isArray(js.json?.journeys), `${js.status}, ${js.json?.journeys?.length ?? "?"}`);
    const n0 = nl.json?.newsletters?.[0];
    if (n0) {
      const d = await call(role, "GET", `${C}/newsletters/${n0.id}`);
      ok(role, "GET newsletter detail", d.status === 200 && typeof d.json?.canSend === "boolean" && !!d.json?.stats, `${d.status}, status ${d.json?.status}, canSend ${d.json?.canSend}`);
      const can = newsletterActions(d.json ?? {});
      // Only call Pause or Resume where the server must refuse it without changing anything.
      if (d.json?.status !== "sending") {
        const p = await call(role, "POST", `${C}/newsletters/${n0.id}/pause`, {});
        ok(role, "POST pause on a newsletter that is not sending is refused", d.json?.canSend ? p.status === 400 : p.status === 403 || p.status === 400, `${p.status} "${msg(p)}"`);
      }
      if (d.json?.status !== "paused") {
        const r = await call(role, "POST", `${C}/newsletters/${n0.id}/resume`, {});
        ok(role, "POST resume on a newsletter that is not paused is refused", r.status === 400 || r.status === 403, `${r.status} "${msg(r)}"`);
      }
      console.log(`NOTE ${role} phone shows for ${n0.id}: pause ${can.pause}, resume ${can.resume}, test ${can.test} (no test mail sent by this smoke)`);
    } else console.log(`NOTE ${role} no newsletters on staging to open`);
    const j0 = js.json?.journeys?.[0];
    if (j0) {
      const d = await call(role, "GET", `${C}/journeys/${j0.id}`);
      ok(role, "GET journey detail", d.status === 200 && typeof d.json?.canSend === "boolean", `${d.status}, status ${d.json?.status}, canSend ${d.json?.canSend}`);
      const can = journeyActions(d.json ?? {});
      console.log(`NOTE ${role} phone shows for journey ${j0.id}: pause ${can.pause}, start ${can.start} (not pressed by this smoke)`);
    } else console.log(`NOTE ${role} no journeys on staging to open`);
  } else {
    const off = await call(role, "GET", `${C}/newsletters`);
    ok(role, "mail merge off: newsletters answer 404 (phone shows Mail merge is off)", off.status === 404, String(off.status));
  }

  // Mail archive.
  if (cfg.json?.mailArchive) {
    const p = await call(role, "GET", "/mail-archive/policy");
    const admin = p.json?.policy?.canManage === true;
    ok(role, "GET /mail-archive/policy", p.status === 200 && typeof p.json?.policy?.enabled === "boolean", `${p.status}, canManage ${admin}`);
    ok(role, `policy canManage matches the role`, admin === (role === "admin"), String(admin));
    const h = await call(role, "GET", "/mail-archive/holds");
    ok(role, "GET /mail-archive/holds", role === "admin" ? h.status === 200 && Array.isArray(h.json?.holds) : h.status === 403, String(h.status));
    const cs = await call(role, "GET", "/mail-archive/cases");
    ok(role, "GET /mail-archive/cases", role === "admin" ? cs.status === 200 && Array.isArray(cs.json?.cases) : cs.status === 403, String(cs.status));
    const s = await call(role, "POST", "/mail-archive/search", { filters: { q: archiveQuery("invoice") } });
    ok(role, "POST /mail-archive/search", role === "admin" ? s.status === 200 && Array.isArray(s.json?.hits) : s.status === 403, `${s.status}, ${s.json?.hits?.length ?? "-"} hits`);
    const s2 = await call(role, "POST", "/mail-archive/search", { filters: { q: archiveQuery("नेपाली ".repeat(60)) } });
    ok(role, "POST /mail-archive/search, 200 character phone cut", role === "admin" ? s2.status === 200 : s2.status === 403, String(s2.status));
  } else {
    const off = await call(role, "GET", "/mail-archive/policy");
    ok(role, "archive off: policy answers 404 (phone shows Mail archive is off)", off.status === 404, String(off.status));
  }

  // Calendar and contacts sync: make one app password for this tester and revoke it at once.
  if (cfg.json?.davSync) {
    const l = await call(role, "GET", "/dav/passwords");
    ok(role, "GET /dav/passwords", l.status === 200 && Array.isArray(l.json?.passwords) && typeof l.json?.server === "string", `${l.status}, ${l.json?.passwords?.length ?? "?"} of ${l.json?.max}`);
    if ((l.json?.passwords?.length ?? 0) < (l.json?.max ?? 0)) {
      const c = await call(role, "POST", "/dav/passwords", { name: passwordName(`M1 smoke ${new Date().toISOString().slice(0, 16)}`) });
      ok(role, "POST /dav/passwords (shown once)", c.status === 201 && typeof c.json?.password === "string" && !!c.json?.item?.id, `${c.status}, password ${c.json?.password ? "returned (not printed)" : "missing"}`);
      if (c.json?.item?.id) {
        const again = await call(role, "GET", "/dav/passwords");
        ok(role, "the list never shows the password again", !JSON.stringify(again.json ?? {}).includes(c.json.password), "");
        const d = await call(role, "DELETE", `/dav/passwords/${c.json.item.id}`);
        ok(role, "DELETE /dav/passwords/:id (revoke)", d.status === 200 && d.json?.revoked === true, String(d.status));
      }
    } else console.log(`NOTE ${role} at the app password limit; create skipped`);
  } else {
    const off = await call(role, "GET", "/dav/passwords");
    console.log(`NOTE ${role} sync off: /dav/passwords answers ${off.status}`);
  }
}

for (const path of ["/contacts?limit=100", `${C}/newsletters`, `${C}/lists`, `${C}/journeys`, "/mail-archive/policy", "/mail-archive/holds", "/dav/passwords"]) {
  const r = await call("none", "GET", path);
  ok("none", `GET ${path} refused without a workspace session`, [401, 403, 404].includes(r.status), String(r.status));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
fs.mkdirSync("/home/user/tab/files/catalogue/verify/m1/work", { recursive: true });
fs.writeFileSync("/home/user/tab/files/catalogue/verify/m1/work/smoke.json", JSON.stringify({ at: new Date().toISOString(), base: BASE, results }, null, 1));
process.exit(failed.length ? 1 : 0);
