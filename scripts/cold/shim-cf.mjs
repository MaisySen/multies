// cloudflare:* stand-ins for the cold start profiler (Node only).
export const env = globalThis.__COLD_ENV;
export function connect() { throw new Error("no sockets in the profiler"); }
export class DurableObject { constructor(state, env) { this.ctx = state; this.env = env; } }
export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export default {};
