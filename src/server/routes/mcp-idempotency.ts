/**
 * R53 (MB-239): the same id on a retry inside MCP write tools.
 *
 * POST /mcp sits behind the Idempotency-Key middleware, so a plain repeat replays the stored answer. The rare case
 * left was a first attempt that committed and then answered 5xx (or was cut off): the retry runs the tool again,
 * and the tool used to make a second row. Each tool call now runs inside a small context carrying the request
 * (and, for a JSON-RPC batch, the message's index), and a create asks mcpCreate(prefix) for its options: the stable
 * id the v1 routes use plus `retry`, so the service looks for the first attempt's row before inserting (one read,
 * only on a retry). Without a key there is no context: random ids and no extra reads, as before.
 *
 * Only this lazily loaded MCP code imports this file; the store is made on the first keyed MCP call.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { idempotentId, idempotentRetry } from "../lib/idempotency";

type McpCall = { req: Request; part?: string };
let store: AsyncLocalStorage<McpCall> | undefined;

/** Runs one tool call with its request (and batch part) in scope. */
export function withMcpCall<T>(call: McpCall, fn: () => T): T {
  store ??= new AsyncLocalStorage<McpCall>();
  return store.run(call, fn);
}

function label(prefix: string, part: string | undefined, i = 0) {
  const bits = [prefix, part, i ? String(i) : undefined].filter((b) => b !== undefined);
  return bits.join(":");
}

async function stableId(req: Request, prefix: string, part: string | undefined, i = 0) {
  const name = label(prefix, part, i);
  const id = await idempotentId(req, name);
  // The id keeps the plain prefix (tsk_..., doc_...) whatever the batch part or item index was.
  return id && name !== prefix ? `${prefix}_${id.slice(name.length + 1)}` : id;
}

/**
 * Options for a service create called from an MCP tool: { id, retry } under an Idempotency-Key, {} without one.
 * `nth` separates two creates of the same kind inside one tool call.
 */
export async function mcpCreate(prefix: string, nth = 0): Promise<{ id?: string; retry?: boolean }> {
  const call = store?.getStore();
  if (!call) return {};
  const id = await stableId(call.req, prefix, call.part, nth);
  return id ? { id, retry: idempotentRetry(call.req) } : {};
}

/** R54 (MB-239): true inside a keyed tool call that retries an earlier attempt (for a write with no row id of its own). */
export function mcpRetry(): boolean {
  const call = store?.getStore();
  return call ? idempotentRetry(call.req) : false;
}

/** n stable ids for a tool that makes several rows of one kind in one call (checklist items). */
export async function mcpIds(prefix: string, n: number): Promise<{ ids?: string[]; retry?: boolean }> {
  const call = store?.getStore();
  if (!call) return {};
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = await stableId(call.req, prefix, call.part, i);
    if (!id) return {};
    ids.push(id);
  }
  return { ids, retry: idempotentRetry(call.req) };
}
