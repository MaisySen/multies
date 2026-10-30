/**
 * The official Stripe SDK, set up to run on both Node and Cloudflare Workers: requests
 * go through the app's fetch (tests inject a fake one) and webhook signatures are
 * checked with Web Crypto.
 */
import Stripe from "stripe";

export { Stripe };

export function stripeClient(secretKey: string, fetchImpl: typeof fetch) {
  return new Stripe(secretKey, {
    httpClient: Stripe.createFetchHttpClient(fetchImpl),
    maxNetworkRetries: 2,
    appInfo: { name: "Multies" },
  });
}

const cryptoProvider = Stripe.createSubtleCryptoProvider();

/** Verifies the Stripe-Signature header and parses the event. Throws on a bad or stale signature (5 minute tolerance). */
export function constructWebhookEvent(stripe: Stripe, rawBody: string, signature: string, secret: string, now: Date) {
  return stripe.webhooks.constructEventAsync(rawBody, signature, secret, 300, cryptoProvider, now.getTime());
}

/** A valid signature header for a payload, for tests and local webhook simulation. */
export function signStripePayload(stripe: Stripe, payload: string, secret: string, now: Date) {
  return stripe.webhooks.generateTestHeaderStringAsync({ payload, secret, timestamp: Math.floor(now.getTime() / 1000), cryptoProvider });
}
