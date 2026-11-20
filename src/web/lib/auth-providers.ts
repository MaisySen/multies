import { api } from "./api";
import type { AuthProviders } from "./auth-client";

/**
 * R30: the sign in providers read, shared by the auth pages, the auth layout and the boot prefetch in
 * main.tsx. Starting it at boot (beside the page's code) and holding the auth card until it answers means
 * the card paints once at its final height: on mobile it used to paint, then grow when the password form
 * arrived, and re-centre (0.26 of layout shift on sign in, Lighthouse mobile, R30 before).
 */
export const authProvidersQuery = {
  queryKey: ["auth-providers"] as const,
  queryFn: () => api.get<AuthProviders>("/account/providers"),
  staleTime: Infinity,
};

/** Pages under the auth layout, whose first paint waits for the providers read. */
export const AUTH_LAYOUT_PATHS = /^\/(?:(?:login|signup|forgot-password|reset-password|email-verified|oauth\/authorize|mnet\/(?:authorize|devices))(?:\/|$)|invite\/)/;

export const isAuthLayoutPath = (pathname: string) => AUTH_LAYOUT_PATHS.test(pathname);
