/**
 * STB1 (startup budget): the Stripe SDK costs about 4 ms of Worker startup CPU when imported at the top, yet only
 * billing calls and the Stripe webhook use it. It loads on the first of those, once per isolate.
 */
type StripeModule = typeof import("./stripe");

let pending: Promise<StripeModule> | null = null;
let loaded: StripeModule | null = null;

export function loadStripe(): Promise<StripeModule> {
  pending ??= import("./stripe").then((m) => (loaded = m)).catch((err: unknown) => { pending = null; throw err; });
  return pending;
}

/** True for an error the Stripe SDK raised. Until the SDK has loaded, nothing can have raised one. */
export function isStripeError(e: unknown): e is Error {
  return loaded !== null && e instanceof loaded.Stripe.errors.StripeError;
}
