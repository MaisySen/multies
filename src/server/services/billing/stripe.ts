/**
 * Minimal Stripe REST client over fetch — no SDK, so it runs unchanged on Node and
 * Cloudflare Workers. Only the calls MyMail needs.
 */
import { hmacSha256Hex, safeEqual } from "../../lib/crypto";

export class StripeError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

interface Params { [key: string]: string | number | boolean | undefined | null | Params | Params[] | string[] }

/** Stripe's form encoding: nested keys as a[b][c], arrays as a[0][b]. */
export function formEncode(params: Params, prefix = ""): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === "object") out.push(formEncode(item as Params, `${key}[${i}]`));
        else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof v === "object") {
      out.push(formEncode(v as Params, key));
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return out.filter(Boolean).join("&");
}

export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  current_period_end?: number;
  items: { data: { price: { id: string }; current_period_end?: number }[] };
  metadata?: Record<string, string>;
}

export interface StripeInvoice {
  id: string; number: string | null; status: string; total: number; currency: string; created: number;
  hosted_invoice_url: string | null; invoice_pdf: string | null; period_start: number; period_end: number;
}

export class StripeClient {
  constructor(private key: string, private fetchImpl: typeof fetch, private base = "https://api.stripe.com/v1") {}

  private async call<T>(method: "GET" | "POST", path: string, params?: Params): Promise<T> {
    const body = params ? formEncode(params) : undefined;
    const url = method === "GET" && body ? `${this.base}${path}?${body}` : `${this.base}${path}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${this.key}`,
        "stripe-version": "2024-06-20",
        ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body: method === "POST" ? body : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string } };
    if (!res.ok) throw new StripeError(json.error?.message ?? `Stripe answered ${res.status}`, res.status, json.error?.code);
    return json as T;
  }

  createCustomer(p: { email: string; name: string; orgId: string }) {
    return this.call<{ id: string }>("POST", "/customers", { email: p.email, name: p.name, metadata: { orgId: p.orgId } });
  }
  createCheckoutSession(p: { customer: string; price: string; orgId: string; successUrl: string; cancelUrl: string }) {
    return this.call<{ id: string; url: string }>("POST", "/checkout/sessions", {
      mode: "subscription", customer: p.customer, client_reference_id: p.orgId,
      line_items: [{ price: p.price, quantity: 1 }],
      subscription_data: { metadata: { orgId: p.orgId } },
      metadata: { orgId: p.orgId },
      allow_promotion_codes: true,
      success_url: p.successUrl, cancel_url: p.cancelUrl,
    });
  }
  createPortalSession(p: { customer: string; returnUrl: string }) {
    return this.call<{ url: string }>("POST", "/billing_portal/sessions", { customer: p.customer, return_url: p.returnUrl });
  }
  retrieveSubscription(id: string) {
    return this.call<StripeSubscription>("GET", `/subscriptions/${encodeURIComponent(id)}`);
  }
  listInvoices(customer: string, limit = 24) {
    return this.call<{ data: StripeInvoice[] }>("GET", "/invoices", { customer, limit });
  }
}

/**
 * Verifies a `Stripe-Signature` header (t=...,v1=...) over the raw body.
 * Rejects signatures older than `toleranceS` to stop replays.
 */
export async function verifyStripeSignature(payload: string, header: string | undefined, secret: string, now: Date, toleranceS = 300): Promise<boolean> {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !sigs.length) return false;
  if (Math.abs(now.getTime() / 1000 - Number(t)) > toleranceS) return false;
  const expected = await hmacSha256Hex(secret, `${t}.${payload}`);
  return sigs.some((s) => safeEqual(s, expected));
}

/** Builds a valid header, for tests and for the local webhook simulator. */
export async function signStripePayload(payload: string, secret: string, now: Date) {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${payload}`)}`;
}
