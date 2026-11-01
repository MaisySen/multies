/**
 * R99: calendar and contacts sync. CalDAV (RFC 4791) and CardDAV (RFC 6352) with sync-collection (RFC 6578) at
 * /dav, signed in with an app password over HTTPS (Basic auth). The app password alone decides who and which
 * workspace, so paths carry no ids. Settings routes for app passwords live at /api/dav (signed in session).
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { HttpError } from "../lib/errors";
import { RateLimiter } from "../lib/rate-limit";
import { parseBody, requireAuth } from "../middleware";
import { sha256Hex } from "../lib/crypto";
import { authenticate, createAppPassword, davEnabled, listAppPasswords, revokeAppPassword, assertDavEnabled, type DavPrincipal } from "../services/dav/app-passwords";
import { ADDRESSBOOK, CALENDARS, DavError, changesSince, collectionInfo, collectionWritable, ctagOf, currentSyncToken, deleteItem, entries, putItem, type CollectionId, type CollectionInfo, type Entry } from "../services/dav/store";
import { child, children, descendants, el, errorDoc, esc, key, multistatusDoc, NS, parseXml, response, statusResponse, type XmlNode, MAX_XML_BYTES } from "../services/dav/xml";

export const DAV_RATE_PER_MIN_IP = 600;
export const DAV_RATE_PER_MIN_PASSWORD = 300;
export const DAV_FAILED_SIGNINS_PER_MIN_IP = 10;
const DAV_HEADER = "1, 3, calendar-access, addressbook";
const ALLOW = "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, REPORT";

const xmlHeaders = { "content-type": "application/xml; charset=utf-8", dav: DAV_HEADER, "cache-control": "no-store" };
const multi = (body: string) => new Response(body, { status: 207, headers: xmlHeaders });
const text = (status: number, msg: string, extra: Record<string, string> = {}) => new Response(`${msg}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", dav: DAV_HEADER, "cache-control": "no-store", ...extra } });

type Target =
  | { kind: "root" } | { kind: "principal" } | { kind: "calhome" } | { kind: "cardhome" }
  | { kind: "collection"; col: CollectionInfo } | { kind: "object"; col: CollectionInfo; name: string };

export const hrefOf = {
  root: "/dav/", principal: "/dav/principal/", calhome: "/dav/cal/", cardhome: "/dav/card/",
  collection: (c: CollectionInfo) => (c.kind === "addressbook" ? `/dav/card/${c.id}/` : `/dav/cal/${c.id}/`),
  object: (c: CollectionInfo, name: string) => `${c.kind === "addressbook" ? `/dav/card/${c.id}/` : `/dav/cal/${c.id}/`}${encodeURIComponent(name)}`,
};

/** Maps a request path to what it names; null for anything else (404). */
export function targetOf(path: string): Target | null {
  const rest = path.replace(/^\/dav\/?/, "");
  let parts: string[];
  try { parts = rest.split("/").filter(Boolean).map(decodeURIComponent); } catch { return null; }
  if (parts.length === 0) return { kind: "root" };
  if (parts[0] === "principal" && parts.length === 1) return { kind: "principal" };
  if (parts[0] === "cal" || parts[0] === "card") {
    if (parts.length === 1) return { kind: parts[0] === "cal" ? "calhome" : "cardhome" };
    const col = collectionInfo(parts[1]);
    if (!col || (col.kind === "addressbook") !== (parts[0] === "card")) return null;
    if (parts.length === 2) return { kind: "collection", col };
    if (parts.length === 3) return { kind: "object", col, name: parts[2] };
  }
  return null;
}

// ---------------------------------------------------------------- properties

const K = {
  resourcetype: key(NS.dav, "resourcetype"), displayname: key(NS.dav, "displayname"), cup: key(NS.dav, "current-user-principal"),
  principalUrl: key(NS.dav, "principal-URL"), owner: key(NS.dav, "owner"), privs: key(NS.dav, "current-user-privilege-set"),
  reports: key(NS.dav, "supported-report-set"), etag: key(NS.dav, "getetag"), ctype: key(NS.dav, "getcontenttype"), syncToken: key(NS.dav, "sync-token"),
  calHome: key(NS.cal, "calendar-home-set"), cardHome: key(NS.card, "addressbook-home-set"), calUser: key(NS.cal, "calendar-user-address-set"),
  calDesc: key(NS.cal, "calendar-description"), comps: key(NS.cal, "supported-calendar-component-set"), calData: key(NS.cal, "calendar-data"),
  cardDesc: key(NS.card, "addressbook-description"), cardSupported: key(NS.card, "supported-address-data"), cardData: key(NS.card, "address-data"),
  ctag: key(NS.cs, "getctag"), color: key(NS.apple, "calendar-color"), order: key(NS.apple, "calendar-order"),
};
const href = (h: string) => `<d:href>${esc(h)}</d:href>`;
const priv = (names: string[]) => names.map((n) => `<d:privilege><d:${n}/></d:privilege>`).join("");
const READ_PRIVS = priv(["read", "read-current-user-privilege-set"]);
const WRITE_PRIVS = priv(["read", "read-current-user-privilege-set", "write", "write-content", "bind", "unbind"]);
const report = (ns: "c" | "card" | "d", name: string) => `<d:supported-report><d:report><${ns}:${name}/></d:report></d:supported-report>`;

type Props = Map<string, () => Promise<string> | string>;

function identityProps(p: DavPrincipal): Props {
  return new Map<string, () => string>([
    [K.cup, () => href(hrefOf.principal)], [K.owner, () => href(hrefOf.principal)],
    [K.calHome, () => href(hrefOf.calhome)], [K.cardHome, () => href(hrefOf.cardhome)],
  ]).set(K.calUser, () => href(`mailto:${p.email}`));
}

/** Properties of a target (bodies of objects only when asked for by name). */
function propsOf(t: Target, p: DavPrincipal, ctx: { list?: Entry[]; entry?: Entry; syncToken?: () => Promise<string> }): Props {
  const props = identityProps(p);
  if (t.kind === "root" || t.kind === "calhome" || t.kind === "cardhome") {
    props.set(K.resourcetype, () => "<d:collection/>");
    props.set(K.displayname, () => (t.kind === "root" ? "Multies" : t.kind === "calhome" ? "Calendars" : "Address books"));
    props.set(K.privs, () => READ_PRIVS);
  } else if (t.kind === "principal") {
    props.set(K.resourcetype, () => "<d:principal/>").set(K.displayname, () => esc(p.name)).set(K.principalUrl, () => href(hrefOf.principal)).set(K.privs, () => READ_PRIVS);
  } else if (t.kind === "collection") {
    const c = t.col;
    const writable = collectionWritable(c.id);
    props.set(K.displayname, () => esc(c.name)).set(K.privs, () => (writable ? WRITE_PRIVS : READ_PRIVS));
    props.set(K.ctag, async () => esc(await ctagOf(ctx.list ?? [])));
    if (ctx.syncToken) props.set(K.syncToken, async () => esc(await ctx.syncToken!()));
    if (c.kind === "calendar") {
      props.set(K.resourcetype, () => "<d:collection/><c:calendar/>").set(K.calDesc, () => esc(c.description)).set(K.comps, () => '<c:comp name="VEVENT"/>')
        .set(K.color, () => c.color).set(K.order, () => String(c.order))
        .set(K.reports, () => report("c", "calendar-query") + report("c", "calendar-multiget") + report("d", "sync-collection"));
    } else {
      props.set(K.resourcetype, () => "<d:collection/><card:addressbook/>").set(K.cardDesc, () => esc(c.description))
        .set(K.cardSupported, () => '<card:address-data-type content-type="text/vcard" version="3.0"/>')
        .set(K.reports, () => report("card", "addressbook-query") + report("card", "addressbook-multiget") + report("d", "sync-collection"));
    }
  } else if (ctx.entry) {
    const e = ctx.entry;
    props.clear();
    props.set(K.resourcetype, () => "").set(K.etag, () => esc(e.etag)).set(K.ctype, () => esc(e.contentType)).set(K.privs, () => (e.canWrite ? WRITE_PRIVS : READ_PRIVS));
    props.set(t.col.kind === "calendar" ? K.calData : K.cardData, () => esc(e.render()));
  }
  return props;
}

/** The property names a PROPFIND or REPORT asks for; null means "all" (allprop, propname or no body). */
export function requestedProps(root: XmlNode | null): string[] | null {
  const prop = child(root, NS.dav, "prop");
  if (!prop) return null;
  return prop.children.map((c) => key(c.ns, c.name));
}

const BODY_PROPS = new Set([K.calData, K.cardData]);
async function respond(hrefStr: string, props: Props, wanted: string[] | null) {
  const names = wanted ?? [...props.keys()].filter((k) => !BODY_PROPS.has(k));
  const found: [string, string][] = [];
  const missing: string[] = [];
  for (const n of names) {
    const get = props.get(n);
    if (get) found.push([n, await get()]); else missing.push(n);
  }
  return response(hrefStr, { found, missing });
}

// ---------------------------------------------------------------- handler

async function readBody(c: Context<AppEnv>, max: number): Promise<string> {
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > max) throw new HttpError(413, "too_large", "Request body too large.");
  const body = await c.req.text();
  if (body.length > max) throw new HttpError(413, "too_large", "Request body too large.");
  return body;
}

function secure(c: Context<AppEnv>) {
  const url = new URL(c.req.url);
  if (url.protocol === "https:" || c.req.header("x-forwarded-proto") === "https") return true;
  return !c.var.deps.config.appUrl.startsWith("https:");
}

async function handle(c: Context<AppEnv>, p: DavPrincipal, t: Target): Promise<Response> {
  const deps = c.var.deps;
  const method = c.req.method.toUpperCase();
  const depth = (c.req.header("depth") ?? "1").trim().toLowerCase();
  const listCache = new Map<CollectionId, Promise<Entry[]>>();
  const listOf = (id: CollectionId) => { if (!listCache.has(id)) listCache.set(id, entries(deps, p, id)); return listCache.get(id)!; };

  if (method === "PROPFIND") {
    const body = await readBody(c, MAX_XML_BYTES);
    const root = body.trim() ? parseXml(body) : null;
    if (body.trim() && !root) return text(400, "That request body is not valid XML.");
    const wanted = requestedProps(root);
    const out: string[] = [];
    const deep = depth !== "0";
    if (t.kind === "object") {
      const e = (await listOf(t.col.id)).find((x) => x.name === t.name);
      if (!e) return text(404, "Not found.");
      out.push(await respond(hrefOf.object(t.col, e.name), propsOf(t, p, { entry: e }), wanted));
      return multi(multistatusDoc(out));
    }
    if (t.kind === "collection") {
      const list = await listOf(t.col.id);
      out.push(await respond(hrefOf.collection(t.col), propsOf(t, p, { list, syncToken: () => currentSyncToken(deps, p, t.col.id, list) }), wanted));
      if (deep) for (const e of list) out.push(await respond(hrefOf.object(t.col, e.name), propsOf({ kind: "object", col: t.col, name: e.name }, p, { entry: e }), wanted));
      return multi(multistatusDoc(out));
    }
    const selfHref = t.kind === "root" ? hrefOf.root : t.kind === "principal" ? hrefOf.principal : t.kind === "calhome" ? hrefOf.calhome : hrefOf.cardhome;
    out.push(await respond(selfHref, propsOf(t, p, {}), wanted));
    if (deep) {
      const kids: Target[] = t.kind === "root" ? [{ kind: "principal" }, { kind: "calhome" }, { kind: "cardhome" }]
        : t.kind === "calhome" ? CALENDARS.map((col) => ({ kind: "collection", col }) as Target)
        : t.kind === "cardhome" ? [{ kind: "collection", col: ADDRESSBOOK }] : [];
      for (const k of kids) {
        if (k.kind === "collection") {
          const list = await listOf(k.col.id);
          out.push(await respond(hrefOf.collection(k.col), propsOf(k, p, { list, syncToken: () => currentSyncToken(deps, p, k.col.id, list) }), wanted));
        } else out.push(await respond(k.kind === "principal" ? hrefOf.principal : k.kind === "calhome" ? hrefOf.calhome : hrefOf.cardhome, propsOf(k, p, {}), wanted));
      }
    }
    return multi(multistatusDoc(out));
  }

  if (method === "REPORT") {
    const body = await readBody(c, MAX_XML_BYTES);
    const root = parseXml(body);
    if (!root) return text(400, "That request body is not valid XML.");
    if (t.kind !== "collection" && t.kind !== "object") return new Response(errorDoc(key(NS.dav, "supported-report"), "Reports run on a calendar or address book."), { status: 403, headers: xmlHeaders });
    const col = t.col;
    const wanted = requestedProps(root) ?? [K.etag];
    const list = await listOf(col.id);
    const one = (e: Entry) => respond(hrefOf.object(col, e.name), propsOf({ kind: "object", col, name: e.name }, p, { entry: e }), wanted);
    const name = `${root.ns}|${root.name}`;
    if (name === `${NS.cal}|calendar-multiget` || name === `${NS.card}|addressbook-multiget`) {
      const byName = new Map(list.map((e) => [e.name, e]));
      const prefix = hrefOf.collection(col);
      const out: string[] = [];
      for (const h of children(root, NS.dav, "href").slice(0, 1000)) {
        const raw = h.text.trim();
        let path = raw;
        try { path = new URL(raw, "https://x").pathname; } catch { /* keep raw */ }
        let leaf: string;
        try { leaf = path.startsWith(prefix) ? decodeURIComponent(path.slice(prefix.length)) : ""; } catch { leaf = ""; }
        const e = byName.get(leaf);
        out.push(e ? await one(e) : statusResponse(raw, "404 Not Found"));
      }
      return multi(multistatusDoc(out));
    }
    if (name === `${NS.cal}|calendar-query` || name === `${NS.card}|addressbook-query`) {
      // Only events live here: a query for to dos or journals finds nothing.
      const wantsOther = col.kind === "calendar" && /name=["'](VTODO|VJOURNAL)["']/i.test(body) && !/name=["']VEVENT["']/i.test(body);
      const out: string[] = [];
      if (!wantsOther) for (const e of t.kind === "object" ? list.filter((x) => x.name === t.name) : list) out.push(await one(e));
      return multi(multistatusDoc(out));
    }
    if (name === `${NS.dav}|sync-collection`) {
      if (t.kind !== "collection") return text(403, "Sync runs on a collection.");
      const token = child(root, NS.dav, "sync-token")?.text.trim() ?? "";
      const out: string[] = [];
      if (!token) {
        for (const e of list) out.push(await one(e));
      } else {
        const diff = await changesSince(deps, p, col.id, token, list);
        if (!diff) return new Response(errorDoc(key(NS.dav, "valid-sync-token"), "That sync token is unknown or too old. Start a full sync."), { status: 403, headers: xmlHeaders });
        for (const e of diff.changed) out.push(await one(e));
        for (const n of diff.removed) out.push(statusResponse(hrefOf.object(col, n), "404 Not Found"));
      }
      const next = await currentSyncToken(deps, p, col.id, list);
      return multi(multistatusDoc(out, `<d:sync-token>${esc(next)}</d:sync-token>`));
    }
    return new Response(errorDoc(key(NS.dav, "supported-report"), "That report is not supported here."), { status: 403, headers: xmlHeaders });
  }

  if (method === "PROPPATCH") {
    // Names and colours are set in Multies; answer every property with 403 so the app keeps its own copy.
    const body = await readBody(c, MAX_XML_BYTES);
    const root = parseXml(body);
    const names = root ? descendants(root, NS.dav, "prop").flatMap((pr) => pr.children.map((x) => key(x.ns, x.name))) : [];
    const selfHref = new URL(c.req.url).pathname;
    const inner = names.length ? `<d:propstat><d:prop>${names.map((n) => el(n)).join("")}</d:prop><d:status>HTTP/1.1 403 Forbidden</d:status></d:propstat>` : "";
    return multi(multistatusDoc([`<d:response>${href(selfHref)}${inner}</d:response>`]));
  }

  if (method === "GET" || method === "HEAD") {
    if (t.kind !== "object") return text(200, "Multies calendar and contacts sync. Add this address in your calendar or contacts app.");
    const e = (await listOf(t.col.id)).find((x) => x.name === t.name);
    if (!e) return text(404, "Not found.");
    const inm = c.req.header("if-none-match");
    if (inm && inm.split(",").map((s) => s.trim()).includes(e.etag)) return new Response(null, { status: 304, headers: { etag: e.etag } });
    const bodyStr = e.render();
    return new Response(method === "HEAD" ? null : bodyStr, { status: 200, headers: { "content-type": e.contentType, etag: e.etag, "cache-control": "no-store", dav: DAV_HEADER } });
  }

  if (method === "PUT") {
    if (t.kind !== "object") return text(405, "Save items inside a calendar or address book.", { allow: ALLOW });
    const body = await readBody(c, 256 * 1024);
    const ct = (c.req.header("content-type") ?? "").toLowerCase();
    if (ct && !ct.includes(t.col.kind === "calendar" ? "text/calendar" : "text/vcard") && !ct.includes("text/x-vcard") && !ct.includes("application/octet-stream")) {
      return text(415, t.col.kind === "calendar" ? "Send text/calendar." : "Send text/vcard.");
    }
    const r = await putItem(deps, p, t.col.id, t.name, body, { ifMatch: c.req.header("if-match"), ifNoneMatch: c.req.header("if-none-match") });
    // No ETag: the stored copy may differ from what was sent (Multies keeps the fields it owns), so the app refetches.
    return new Response(null, { status: r.status, headers: { dav: DAV_HEADER, ...(r.created ? { location: hrefOf.object(t.col, t.name) } : {}) } });
  }

  if (method === "DELETE") {
    if (t.kind !== "object") return text(403, "Calendars and address books cannot be deleted from here.");
    await deleteItem(deps, p, t.col.id, t.name, { ifMatch: c.req.header("if-match") });
    return new Response(null, { status: 204, headers: { dav: DAV_HEADER } });
  }

  if (method === "MKCOL" || method === "MKCALENDAR" || method === "MOVE" || method === "COPY" || method === "LOCK" || method === "UNLOCK") {
    return text(403, "That is not available here. Use Multies to change calendars and address books.");
  }
  return text(405, "Method not allowed.", { allow: ALLOW });
}

/** Maps a service error to a DAV answer: 412 and 404 as they are, 422 as 403 with the message. */
function davError(e: { status: number; code: string; message: string }) {
  const status = e.status === 422 ? 403 : e.status;
  if (status === 412 || status === 403 || status === 409) {
    const pre = e.code === "precondition_failed" ? key(NS.dav, "getetag") : e.code === "valid_calendar_data" ? key(NS.cal, "valid-calendar-data") : e.code === "valid_address_data" ? key(NS.card, "valid-address-data") : key(NS.dav, "need-privileges");
    return new Response(errorDoc(pre, e.message), { status, headers: xmlHeaders });
  }
  return text(status, e.message);
}

export function davRoutes() {
  const ipLimiter = new RateLimiter(DAV_RATE_PER_MIN_IP, 60_000);
  const pwLimiter = new RateLimiter(DAV_RATE_PER_MIN_PASSWORD, 60_000);
  const failLimiter = new RateLimiter(DAV_FAILED_SIGNINS_PER_MIN_IP, 60_000);
  return new Hono<AppEnv>().all("*", async (c) => {
    const deps = c.var.deps;
    if (!davEnabled(deps)) return text(404, "Not found.");
    if (!secure(c)) return text(403, "Use https.");
    if (!ipLimiter.take(c.var.ip)) return text(429, "Too many requests. Try again in a minute.", { "retry-after": "60" });
    const t = targetOf(c.req.path);
    if (c.req.method.toUpperCase() === "OPTIONS") return new Response(null, { status: 200, headers: { dav: DAV_HEADER, allow: ALLOW, "cache-control": "no-store" } });
    const header = c.req.header("authorization");
    const p = header ? await authenticate(deps, header) : null;
    if (!p) {
      if (header && !failLimiter.take(c.var.ip)) return text(429, "Too many failed sign ins. Try again in a minute.", { "retry-after": "60" });
      return text(401, "Sign in with your email and an app password from Multies, Settings, Calendar.", { "www-authenticate": 'Basic realm="Multies", charset="UTF-8"' });
    }
    if (!pwLimiter.take(p.passwordId)) return text(429, "Too many requests. Try again in a minute.", { "retry-after": "60" });
    if (!t) return text(404, "Not found.");
    try {
      return await handle(c, p, t);
    } catch (e) {
      if (e instanceof HttpError || e instanceof DavError) return davError(e);
      throw e;
    }
  });
}

/** /.well-known/caldav and /.well-known/carddav (RFC 6764) point at /dav/. */
export function davWellKnown(c: Context<AppEnv>) {
  if (!davEnabled(c.var.deps)) return text(404, "Not found.");
  return new Response(null, { status: 301, headers: { location: "/dav/", "cache-control": "no-store" } });
}

// ---------------------------------------------------------------- settings (signed in)

const CreateBody = z.object({ name: z.string().min(1).max(60) });

/** An unsigned configuration profile for iPhone, iPad and Mac: both accounts, no password (the device asks for it). */
export async function mobileConfig(appUrl: string, user: { id: string; email: string }) {
  const u = new URL(appUrl);
  const ssl = u.protocol === "https:";
  const port = u.port ? Number(u.port) : ssl ? 443 : 80;
  const uuid = async (seed: string) => { const h = await sha256Hex(`${seed}:${user.id}`); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase(); };
  const s = (v: string) => `<string>${esc(v)}</string>`;
  const ident = u.hostname.split(".").reverse().join(".");
  const account = async (kind: "CalDAV" | "CardDAV", label: string) => {
    const id = await uuid(kind);
    return `<dict><key>${kind}AccountDescription</key>${s(label)}<key>${kind}HostName</key>${s(u.hostname)}<key>${kind}Port</key><integer>${port}</integer>`
      + `<key>${kind}PrincipalURL</key>${s("/dav/principal/")}<key>${kind}UseSSL</key>${ssl ? "<true/>" : "<false/>"}<key>${kind}Username</key>${s(user.email)}`
      + `<key>PayloadDescription</key>${s(label)}<key>PayloadDisplayName</key>${s(label)}<key>PayloadIdentifier</key>${s(`${ident}.${kind.toLowerCase()}.${id}`)}`
      + `<key>PayloadType</key>${s(`com.apple.${kind.toLowerCase()}.account`)}<key>PayloadUUID</key>${s(id)}<key>PayloadVersion</key><integer>1</integer></dict>`;
  };
  const top = await uuid("profile");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>`
    + `<key>PayloadContent</key><array>${await account("CalDAV", "Multies calendar")}${await account("CardDAV", "Multies contacts")}</array>`
    + `<key>PayloadDescription</key>${s("Adds your Multies calendar and contacts. Your device asks for your app password while it installs.")}`
    + `<key>PayloadDisplayName</key>${s("Multies calendar and contacts")}<key>PayloadIdentifier</key>${s(`${ident}.dav.${top}`)}`
    + `<key>PayloadRemovalDisallowed</key><false/><key>PayloadType</key>${s("Configuration")}<key>PayloadUUID</key>${s(top)}<key>PayloadVersion</key><integer>1</integer></dict></plist>\n`;
}

export function davSettingsRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/passwords", async (c) => c.json(await listAppPasswords(c.var.deps, c.var.auth)))
    .post("/passwords", async (c) => c.json(await createAppPassword(c.var.deps, c.var.auth, await parseBody(c, CreateBody), c.var.ip), 201))
    .delete("/passwords/:id", async (c) => c.json(await revokeAppPassword(c.var.deps, c.var.auth, c.req.param("id"), c.var.ip)))
    .get("/profile.mobileconfig", async (c) => {
      assertDavEnabled(c.var.deps);
      await listAppPasswords(c.var.deps, c.var.auth); // the same person checks
      const body = await mobileConfig(c.var.deps.config.appUrl, { id: c.var.auth.userId, email: c.var.auth.email });
      return new Response(body, { headers: { "content-type": "application/x-apple-aspen-config", "content-disposition": 'attachment; filename="multies-sync.mobileconfig"', "cache-control": "no-store" } });
    });
}
