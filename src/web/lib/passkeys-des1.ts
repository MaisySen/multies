/**
 * DES1 passkeys in the browser (PASSKEY_DES1). The WebAuthn helper is loaded only when a passkey is used, so no page
 * pays for it up front. The browser asks for Face ID, a fingerprint, the device PIN or a security key; nothing secret
 * leaves the device.
 */
import { api, ApiError } from "./api";

export const passkeysSupported = (): boolean => typeof window !== "undefined" && typeof window.PublicKeyCredential === "function";

/** The person closed the browser's passkey sheet, or it timed out: not an error worth a red message. */
export function wasCancelled(err: unknown): boolean {
  const name = (err as { name?: string; cause?: { name?: string } } | null)?.name;
  const cause = (err as { cause?: { name?: string } } | null)?.cause?.name;
  return name === "NotAllowedError" || name === "AbortError" || cause === "NotAllowedError" || cause === "AbortError" || (err as { code?: string } | null)?.code === "ERROR_CEREMONY_ABORTED";
}

export function passkeyMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  const code = (err as { code?: string } | null)?.code;
  if (code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") return "This passkey is already added.";
  if (code === "ERROR_INVALID_DOMAIN" || code === "ERROR_INVALID_RP_ID") return "Passkeys work on this app's own address only.";
  return fallback;
}

export async function addPasskey(name?: string): Promise<void> {
  const { startRegistration } = await import("@simplewebauthn/browser");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { options } = await api.post<{ options: any }>("/passkeys/register/options", {});
  const response = await startRegistration({ optionsJSON: options });
  await api.post("/passkeys/register", { response, ...(name ? { name } : {}) });
}

/** `autofill`: the quiet way, offered in the email field's suggestions where the browser supports it. */
export async function signInWithPasskey(autofill = false): Promise<void> {
  const { startAuthentication, browserSupportsWebAuthnAutofill } = await import("@simplewebauthn/browser");
  if (autofill && !(await browserSupportsWebAuthnAutofill())) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { options } = await api.post<{ options: any }>("/passkeys/sign-in/options", {});
  const response = await startAuthentication({ optionsJSON: options, useBrowserAutofill: autofill });
  await api.post("/passkeys/sign-in", { response });
}
