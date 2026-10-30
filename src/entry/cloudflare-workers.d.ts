/** R40: the Workers runtime module that exposes the bindings at script startup (import { env } from "cloudflare:workers"). */
declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
}
