/**
 * The auth module. Humans sign in through the identity provider (or the app's own password
 * form where that is on); agents and scripts use personal API keys and MCP tokens, which are
 * scoped and stored hashed (see services/developer). Every route reaches a person through
 * the guards in ./guards.ts.
 */
export { authOptions, createAuth, authFor, type Auth } from "./options";
export { SSO_METHODS, loginMethodFor } from "./session";
export { authMode, localPasswordEnabled, idpIssuer, type AuthMode } from "./config";
export { idpLogoutUrl, IDP_ID } from "./providers";
export { verifyIdToken, IdTokenError } from "./tokens";
export { mayLinkByEmail } from "./linking";
export { parseSocialConnections, socialAuthorizeParams, providerEmailVerified, connectionOfSubject, SOCIAL_CONNECTIONS, type SocialConnection } from "./social-connections";
