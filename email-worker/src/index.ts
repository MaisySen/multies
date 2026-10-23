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
  const signature = await sign(env.MYMAIL_KEY_SECRET, ts, message.from, message.to, body);

  let res: Response;
  try {
    res = await fetchFn(env.MYMAIL_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "message/rfc822",
        "x-mymail-key": env.MYMAIL_KEY_ID,
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
  if (answer?.action === "accept") return;
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
