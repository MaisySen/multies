/**
 * MyMail inbound Email Worker for Cloudflare Email Routing.
 *
 * Cloudflare receives mail for your domain (MX → route*.mx.cloudflare.net) and
 * hands each message to this worker. The worker signs the raw message and POSTs it
 * to MyMail, then accepts or rejects (bounces) based on MyMail's answer.
 *
 * Bindings (wrangler.toml / dashboard):
 *   MYMAIL_WEBHOOK_URL   https://your-mymail.example/api/inbound/cloudflare
 *   MYMAIL_KEY_ID        the inbound key id from MyMail → Settings → Inbound
 *   MYMAIL_KEY_SECRET    its secret (set with `wrangler secret put MYMAIL_KEY_SECRET`)
 *   FALLBACK_FORWARD     optional verified address to forward to if MyMail is unreachable
 *   MYMAIL_ROUTES        optional JSON: recipient domain to another Multies host, for example
 *                        {"multies.si": {"url": "https://multies.si/api/inbound/cloudflare", "keyId": "ink_...", "secret": "MYMAIL_KEY_SECRET_PROD"}}
 *                        where "secret" names another secret binding. Other domains use the defaults above.
 *   MYMAIL_COPY_TO       optional JSON: recipient address to a verified Email Routing destination that also gets
 *                        a copy once Multies accepted the message, for example {"support@multies.si": "someone@example.com"}
 */

interface ForwardableEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
  forward(rcptTo: string, headers?: Headers): Promise<void>;
}

export interface Env {
  MYMAIL_WEBHOOK_URL: string;
  MYMAIL_KEY_ID: string;
  MYMAIL_KEY_SECRET: string;
  FALLBACK_FORWARD?: string;
  MYMAIL_ROUTES?: string;
  MYMAIL_COPY_TO?: string;
  [secret: string]: string | undefined;
}

interface Target { url: string; keyId: string; secret: string }

/** Picks the Multies host for a recipient: a MYMAIL_ROUTES entry for its domain, else the defaults. */
export function targetFor(env: Env, rcptTo: string): Target {
  const domain = rcptTo.toLowerCase().split("@").pop() ?? "";
  if (env.MYMAIL_ROUTES) {
    try {
      const routes = JSON.parse(env.MYMAIL_ROUTES) as Record<string, { url: string; keyId: string; secret: string }>;
      const r = routes[domain];
      const secret = r ? env[r.secret] : undefined;
      if (r && secret) return { url: r.url, keyId: r.keyId, secret };
    } catch {
      console.error("[mymail] MYMAIL_ROUTES is not valid JSON; using the default host");
    }
  }
  return { url: env.MYMAIL_WEBHOOK_URL, keyId: env.MYMAIL_KEY_ID, secret: env.MYMAIL_KEY_SECRET };
}

/** The verified destination that keeps a copy of mail for this recipient (MYMAIL_COPY_TO), if any. */
export function copyFor(env: Env, rcptTo: string): string | null {
  if (!env.MYMAIL_COPY_TO) return null;
  try {
    const map = JSON.parse(env.MYMAIL_COPY_TO) as Record<string, unknown>;
    const v = map[rcptTo.toLowerCase()];
    return typeof v === "string" && v.includes("@") ? v : null;
  } catch {
    console.error("[mymail] MYMAIL_COPY_TO is not valid JSON; no copies");
    return null;
  }
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

export async function sign(secret: string, ts: string, from: string, to: string, body: ArrayBuffer): Promise<string> {
  const bodyHash = hex(await crypto.subtle.digest("SHA-256", body));
  const payload = `${ts}\n${from.toLowerCase()}\n${to.toLowerCase()}\n${bodyHash}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
}

export async function deliver(message: ForwardableEmailMessage, env: Env, fetchFn: typeof fetch = fetch) {
  const body = await new Response(message.raw).arrayBuffer();
  const ts = Math.floor(Date.now() / 1000).toString();
  const target = targetFor(env, message.to);
  const signature = await sign(target.secret, ts, message.from, message.to, body);

  let res: Response;
  try {
    res = await fetchFn(target.url, {
      method: "POST",
      headers: {
        "content-type": "message/rfc822",
        "x-mymail-key": target.keyId,
        "x-mymail-timestamp": ts,
        "x-mymail-envelope-from": message.from,
        "x-mymail-envelope-to": message.to,
        "x-mymail-signature": signature,
      },
      body,
    });
  } catch (err) {
    return fallback(message, env, `MyMail unreachable: ${String(err)}`);
  }

  const answer = (await res.json().catch(() => null)) as { action?: string; reason?: string } | null;
  if (answer?.action === "accept") {
    // A copy for a person who used to get this address by forward. Its failure never bounces the original.
    const copy = copyFor(env, message.to);
    if (copy) await message.forward(copy).catch((err) => console.error(`[mymail] copy to ${copy} failed: ${String(err)}`));
    return;
  }
  if (answer?.action === "reject") return message.setReject(answer.reason ?? "Rejected by MyMail");
  return fallback(message, env, answer?.reason ?? `MyMail answered HTTP ${res.status}`);
}

async function fallback(message: ForwardableEmailMessage, env: Env, why: string) {
  console.error(`[mymail] ${why}`);
  if (env.FALLBACK_FORWARD) return message.forward(env.FALLBACK_FORWARD);
  // No fallback: reject rather than silently drop. The sender gets a bounce and can retry.
  message.setReject("Temporary failure delivering to mailbox, please retry later");
}

export default {
  async email(message: ForwardableEmailMessage, env: Env) {
    await deliver(message, env);
  },
};
