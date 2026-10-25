/**
 * The socket opener used when the host injects none (Node: the server, tests). Workers inject the
 * cloudflare:sockets opener from src/entry/worker.ts, so node:net is never loaded there.
 */
import type { SocketOpener } from "./socket";

export function nodeSocketOpenerLazy(allowSelfSigned: boolean): SocketOpener {
  return async (opts) => {
    const { nodeSocketOpener } = await import("./node-socket");
    return nodeSocketOpener({ allowSelfSigned })(opts);
  };
}
