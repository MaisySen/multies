/**
 * Round 2: the header the Better Auth handler reads the client address from. app.ts sets it from clientIp
 * (middleware.ts) on every /api/auth request and replaces any value the client sent.
 */
export const CLIENT_IP_HEADER = "x-multies-client-ip";
