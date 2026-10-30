/** The Workers TCP sockets API (https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/). */
declare module "cloudflare:sockets" {
  export function connect(address: { hostname: string; port: number }, options?: { secureTransport?: "off" | "on" | "starttls"; allowHalfOpen?: boolean }): unknown;
}
