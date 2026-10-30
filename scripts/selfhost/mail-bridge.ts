/**
 * Mail bridge for self-hosted Multies: the local stand-in for the Cloudflare Email Worker.
 *
 * Stalwart receives mail from the internet on port 25 and calls this bridge through an
 * MTA Hook (an HTTP POST at the DATA stage, JSON in and out, see docs/self-host.md).
 * The bridge rebuilds the raw message, signs it with a Multies inbound key exactly the
 * way email-worker/ does, and POSTs it to /api/inbound/cloudflare once per recipient.
 *
 * Answers to Stalwart:
 *   every recipient accepted by Multies   -> "discard": Stalwart says 250 and stores nothing
 *                                           (Multies already has it, and copies it into the
 *                                           Stalwart inbox itself for mailboxes with mail app access)
 *   Multies unreachable or asks to retry  -> "reject" with 451, so the sender tries again later
 *   every recipient refused              -> "reject" with Multies' code and reason
 *   authenticated sessions               -> "accept" (mail apps and Multies' own sending relay out)
 *
 * Environment:
 *   MYMAIL_INBOUND_URL   http://mymail:8787/api/inbound/cloudflare
 *   MYMAIL_INBOUND_KEYS  keyId:secret, comma separated (one per workspace, from Settings, Inbound)
 *   MTA_HOOK_TOKEN       shared bearer token Stalwart sends (set by scripts/selfhost/stalwart.ts)
 *   BRIDGE_PORT          default 8025
 *
 * Node built-ins only.
 */
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface HookRequest {
  context?: { stage?: string; sasl?: { login?: string } | null; queue?: { id?: string } };
  envelope?: { from?: { address?: string }; to?: { address?: string }[] };
  message?: { headers?: [string, string][]; serverHeaders?: [string, string][]; contents?: string; size?: number };
}

export interface HookResponse {
  action: "accept" | "discard" | "reject" | "quarantine";
  response?: { status: number; enhancedStatus?: string; message?: string };
}

export interface InboundKey { id: string; secret: string }

export interface BridgeOptions {
  inboundUrl: string;
  keys: InboundKey[];
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

/** Parses MYMAIL_INBOUND_KEYS ("id:secret,id:secret"). */
export function parseKeys(value: string | undefined): InboundKey[] {
  return (value ?? "").split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf(":");
    return { id: p.slice(0, i), secret: p.slice(i + 1) };
  }).filter((k) => k.id && k.secret);
}

/** Header values from Stalwart may or may not keep their leading space; normalise to "Name: value". */
function headerLine([name, value]: [string, string]): string {
  const v = value.replace(/\r?\n$/, "");
  return `${name}:${/^[ \t]/.test(v) ? v : ` ${v}`}`;
}

/** Rebuilds the RFC 5322 message: server headers (Received and so on), the message headers, a blank line, the body. */
export function rawFromHook(req: HookRequest): Buffer {
  const lines = [...(req.message?.serverHeaders ?? []), ...(req.message?.headers ?? [])].map(headerLine);
  const head = lines.join("\r\n").replace(/\r?\n/g, "\r\n");
  return Buffer.concat([Buffer.from(`${head}\r\n\r\n`, "utf8"), Buffer.from(req.message?.contents ?? "", "utf8")]);
}

/** Same signature as email-worker/src/index.ts and src/server/services/mail/inbound-keys.ts. */
export function signDelivery(secret: string, ts: string, from: string, to: string, body: Uint8Array): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const payload = `${ts}\n${from.toLowerCase()}\n${to.toLowerCase()}\n${bodyHash}`;
  return createHmac("sha256", secret).update(payload).digest("hex");
}

type Answer = { action: "accept" | "reject" | "retry"; code: number; reason: string };

async function deliverOne(opts: BridgeOptions, from: string, to: string, body: Buffer): Promise<Answer> {
  const doFetch = opts.fetch ?? fetch;
  let last: Answer = { action: "retry", code: 451, reason: "No inbound key is set up for the mail bridge." };
  for (const key of opts.keys) {
    const ts = Math.floor((opts.now?.() ?? Date.now()) / 1000).toString();
    let res: Response;
    try {
      res = await doFetch(opts.inboundUrl, {
        method: "POST",
        headers: {
          "content-type": "message/rfc822",
          "x-mymail-key": key.id,
          "x-mymail-timestamp": ts,
          "x-mymail-envelope-from": from,
          "x-mymail-envelope-to": to,
          "x-mymail-signature": signDelivery(key.secret, ts, from, to, body),
        },
        body: new Uint8Array(body),
      });
    } catch (err) {
      return { action: "retry", code: 451, reason: `Multies is not reachable: ${(err as Error).message}` };
    }
    const answer = (await res.json().catch(() => null)) as { action?: string; code?: number; reason?: string } | null;
    const reason = answer?.reason ?? `Multies answered HTTP ${res.status}`;
    if (answer?.action === "accept") return { action: "accept", code: 250, reason: "Delivered" };
    // A key belongs to one workspace: try the next key when this one does not manage the domain.
    if (answer?.action === "reject" && /not managed by this signing key/i.test(reason)) { last = { action: "reject", code: 550, reason: `No mailbox for ${to}.` }; continue; }
    if (answer?.action === "reject") return { action: "reject", code: answer.code && answer.code >= 500 ? answer.code : 550, reason };
    return { action: "retry", code: 451, reason };
  }
  return last;
}

export async function handleHook(req: HookRequest, opts: BridgeOptions): Promise<HookResponse> {
  if (req.context?.sasl?.login) return { action: "accept" };
  const from = req.envelope?.from?.address ?? "";
  const rcpts = [...new Set((req.envelope?.to ?? []).map((t) => (t.address ?? "").toLowerCase()).filter(Boolean))];
  if (!rcpts.length) return { action: "reject", response: { status: 554, enhancedStatus: "5.5.1", message: "No recipients." } };
  const body = rawFromHook(req);
  const answers = await Promise.all(rcpts.map((to) => deliverOne(opts, from, to, body)));
  answers.forEach((a, i) => opts.log?.(`[bridge] ${from || "<>"} -> ${rcpts[i]}: ${a.action} ${a.code} ${a.reason}`));
  if (answers.some((a) => a.action === "retry")) {
    const why = answers.find((a) => a.action === "retry")!.reason;
    return { action: "reject", response: { status: 451, enhancedStatus: "4.3.0", message: `Temporary failure, try again later (${why})` } };
  }
  if (answers.every((a) => a.action === "reject")) {
    const first = answers[0];
    return { action: "reject", response: { status: first.code, enhancedStatus: first.code === 552 ? "5.3.4" : "5.1.1", message: first.reason } };
  }
  // At least one recipient took it. Recipients Multies refused are dropped here (see docs/self-host.md).
  return { action: "discard", response: { status: 250, enhancedStatus: "2.0.0", message: "Delivered to Multies" } };
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function startBridge(opts: BridgeOptions & { port: number; token: string; maxBytes?: number }) {
  const maxBytes = opts.maxBytes ?? 60 * 1024 * 1024;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && req.url === "/health") return reply(200, { ok: true, keys: opts.keys.length });
    if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });
    const auth = req.headers.authorization ?? "";
    if (!opts.token || !sameToken(auth, `Bearer ${opts.token}`)) return reply(401, { error: "unauthorised" });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) return reply(413, { action: "reject", response: { status: 552, enhancedStatus: "5.3.4", message: "Message too large." } });
      chunks.push(chunk as Buffer);
    }
    let hook: HookRequest;
    try { hook = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HookRequest; } catch { return reply(400, { error: "bad_json" }); }
    try {
      reply(200, await handleHook(hook, opts));
    } catch (err) {
      opts.log?.(`[bridge] error: ${(err as Error).message}`);
      reply(200, { action: "reject", response: { status: 451, enhancedStatus: "4.3.0", message: "Temporary failure, try again later." } });
    }
  });
  server.listen(opts.port, () => opts.log?.(`[bridge] listening on :${opts.port}, ${opts.keys.length} inbound key(s), posting to ${opts.inboundUrl}`));
  return server;
}

const isMain = process.argv[1] && /mail-bridge\.(ts|js|mjs)$/.test(process.argv[1]);
if (isMain) {
  const env = process.env;
  if (!env.MTA_HOOK_TOKEN) { console.error("Set MTA_HOOK_TOKEN."); process.exit(1); }
  const keys = parseKeys(env.MYMAIL_INBOUND_KEYS);
  if (!keys.length) console.warn("[bridge] MYMAIL_INBOUND_KEYS is empty: inbound mail is answered with a temporary failure until you add a key (docs/self-host.md).");
  startBridge({
    port: Number(env.BRIDGE_PORT ?? 8025),
    token: env.MTA_HOOK_TOKEN,
    inboundUrl: env.MYMAIL_INBOUND_URL ?? "http://mymail:8787/api/inbound/cloudflare",
    keys,
    log: (line) => console.log(line),
  });
}
