/**
 * Round 25: "Continue with Google" and "Continue with Microsoft" on the sign in and sign up pages.
 *
 * Both go through the identity provider (Auth0): the app sends the person to its authorize
 * endpoint with connection=google-oauth2 or connection=windowslive, so the provider skips its own
 * page and opens Google or Microsoft straight away. The callback is the usual /api/auth/callback/auth0.
 *
 * AUTH0_SOCIAL_CONNECTIONS lists the connections this deployment shows as buttons, for example
 * "google-oauth2,windowslive". Unset or empty means no buttons (production until it is turned on).
 * Unknown names are ignored, so a typo can never put a broken button on the page.
 */

export const SOCIAL_CONNECTIONS = ["google-oauth2", "windowslive"] as const;
export type SocialConnection = (typeof SOCIAL_CONNECTIONS)[number];

/** Reads AUTH0_SOCIAL_CONNECTIONS: comma or space separated, case and order kept to the known list. */
export function parseSocialConnections(raw: string | undefined | null): SocialConnection[] {
  if (!raw) return [];
  const asked = new Set(raw.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean));
  return SOCIAL_CONNECTIONS.filter((c) => asked.has(c));
}

export function isSocialConnection(v: unknown): v is SocialConnection {
  return typeof v === "string" && (SOCIAL_CONNECTIONS as readonly string[]).includes(v);
}

/** The extra authorize parameter for one button: Auth0 reads `connection` and goes straight to that provider. */
export function socialAuthorizeParams(connection: SocialConnection): { connection: SocialConnection } {
  return { connection };
}

/**
 * The provider's subject names the connection before the bar: "google-oauth2|1234", "windowslive|abc",
 * "auth0|..." for the email and password database, "email|..." for one time codes.
 */
export function connectionOfSubject(sub: unknown): string | null {
  if (typeof sub !== "string") return null;
  const i = sub.indexOf("|");
  return i > 0 ? sub.slice(0, i) : null;
}

/**
 * Whether the provider vouches for this email, for linking to an existing Multies account.
 * Only a real boolean true counts: a missing claim, false, or a string "true" is unverified.
 * Better Auth then links a sign in to the account with the same email only when this is true
 * (no provider is trusted by name, see linking.ts), and refuses to link otherwise, so a Google
 * or Microsoft sign in can never create a second person for an address that already has one.
 */
export function providerEmailVerified(profile: Record<string, unknown>): boolean {
  return profile.email_verified === true;
}
