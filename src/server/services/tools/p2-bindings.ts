/**
 * Tools P2 bindings the advanced features share.
 *
 * - AiRunner: Workers AI (binding AI). Only ever called through services/tools/ai-meter (H3), which
 *   checks the hard daily cap first, so the account stays inside the free daily allocation.
 * - ToolFileStore: files that must outlive one engine job (share links, signing requests). Workers KV
 *   with each value's own expiry (no R2). Keys live under "tools/" in the IMPORT_FILES namespace.
 *   A KV value holds at most 25 MiB.
 */
export interface AiRunner {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface StoredToolFile { bytes: ArrayBuffer; metadata: Record<string, string> | null }

export interface ToolFileStore {
  readonly name: string;
  put(key: string, bytes: ArrayBuffer | Uint8Array, opts: { ttlSeconds: number; metadata?: Record<string, string> }): Promise<void>;
  get(key: string): Promise<StoredToolFile | null>;
  delete(key: string): Promise<void>;
}

export const TOOL_FILE_MAX_BYTES = 25 * 1024 * 1024;
/** KV refuses an expiry under 60 seconds. */
const MIN_TTL = 60;
const PREFIX = "tools/";

interface KvLike {
  put(key: string, value: ArrayBuffer | Uint8Array, opts?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
  getWithMetadata(key: string, type: "arrayBuffer"): Promise<{ value: ArrayBuffer | null; metadata: unknown }>;
  delete(key: string): Promise<void>;
}

export function kvToolFileStore(kv: unknown): ToolFileStore {
  const k = kv as KvLike;
  return {
    name: "kv",
    async put(key, bytes, opts) {
      if (bytes.byteLength > TOOL_FILE_MAX_BYTES) throw new Error("tool_file_too_large");
      await k.put(PREFIX + key, bytes, { expirationTtl: Math.max(MIN_TTL, Math.floor(opts.ttlSeconds)), metadata: opts.metadata });
    },
    async get(key) {
      const r = await k.getWithMetadata(PREFIX + key, "arrayBuffer");
      return r.value ? { bytes: r.value, metadata: (r.metadata as Record<string, string> | null) ?? null } : null;
    },
    async delete(key) { await k.delete(PREFIX + key); },
  };
}

/** In process store for tests and the local server (TOOL_FILES=memory). Honours expiry. */
export class MemoryToolFileStore implements ToolFileStore {
  readonly name = "memory";
  private m = new Map<string, { bytes: ArrayBuffer; metadata: Record<string, string> | null; until: number }>();
  constructor(private now: () => number = () => Date.now()) {}
  async put(key: string, bytes: ArrayBuffer | Uint8Array, opts: { ttlSeconds: number; metadata?: Record<string, string> }) {
    if (bytes.byteLength > TOOL_FILE_MAX_BYTES) throw new Error("tool_file_too_large");
    const copy = bytes instanceof Uint8Array ? bytes.slice().buffer : bytes.slice(0);
    this.m.set(key, { bytes: copy as ArrayBuffer, metadata: opts.metadata ?? null, until: this.now() + Math.max(MIN_TTL, opts.ttlSeconds) * 1000 });
  }
  async get(key: string) {
    const v = this.m.get(key);
    if (!v) return null;
    if (v.until <= this.now()) { this.m.delete(key); return null; }
    return { bytes: v.bytes, metadata: v.metadata };
  }
  async delete(key: string) { this.m.delete(key); }
}
