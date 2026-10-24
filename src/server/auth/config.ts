import type { AppConfig } from "../config";

/**
 * How people sign in on this deployment, read from config once.
 * - idp: the OIDC identity provider (Universal Login) is configured.
 * - localPassword: the app's own email and password form is on.
 * At least one is always on: with no identity provider the password form cannot be turned off,
 * so a self host can never lock itself out.
 */
export interface AuthMode { idp: boolean; localPassword: boolean; mobile: boolean }

export function authMode(config: Pick<AppConfig, "auth">): AuthMode {
  const idp = !!config.auth.auth0;
  return { idp, localPassword: localPasswordEnabled(config), mobile: !!config.auth.auth0?.nativeClientId };
}

export function localPasswordEnabled(config: Pick<AppConfig, "auth">): boolean {
  return config.auth.localPassword || !config.auth.auth0;
}

/** The issuer the identity provider signs with: https://<domain>/ (trailing slash included). */
export function idpIssuer(domain: string): string {
  return `https://${domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/`;
}
