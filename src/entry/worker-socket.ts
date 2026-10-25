/**
 * The Workers adapter for MailSocket: cloudflare:sockets connect(), with TLS from the first
 * byte (993, 465) or STARTTLS (587). Workers check certificates and offer no way to skip that.
 */
import { connect } from "cloudflare:sockets";
import { SocketError, type MailSocket, type SocketOpener, type SocketOptions } from "../server/services/connect/socket";

interface CfSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<unknown>;
  startTls(): CfSocket;
  close(): Promise<void>;
}

class WorkerMailSocket implements MailSocket {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  constructor(private s: CfSocket) {
    this.reader = s.readable.getReader();
    this.writer = s.writable.getWriter();
  }
  async read() {
    try {
      const { value, done } = await this.reader.read();
      return done || !value ? null : value;
    } catch (e) { throw new SocketError("closed", (e as Error).message); }
  }
  async write(data: Uint8Array) {
    try { await this.writer.write(data); } catch (e) { throw new SocketError("closed", (e as Error).message); }
  }
  async startTls(): Promise<MailSocket> {
    this.reader.releaseLock();
    this.writer.releaseLock();
    try {
      const t = this.s.startTls();
      await t.opened;
      return new WorkerMailSocket(t);
    } catch (e) { throw new SocketError("tls_failed", (e as Error).message); }
  }
  async close() { try { await this.s.close(); } catch { /* already closed */ } }
}

export const workerSocketOpener: SocketOpener = async (o: SocketOptions) => {
  let s: CfSocket;
  try {
    s = connect({ hostname: o.host, port: o.port }, { secureTransport: o.security === "tls" ? "on" : "starttls", allowHalfOpen: false }) as unknown as CfSocket;
    await Promise.race([s.opened, new Promise((_, reject) => setTimeout(() => reject(new SocketError("timeout", `No answer from ${o.host}:${o.port}.`)), o.timeoutMs ?? 15_000))]);
  } catch (e) {
    if (e instanceof SocketError) throw e;
    const msg = (e as Error).message ?? String(e);
    throw new SocketError(/tls|certificate|ssl/i.test(msg) ? "tls_failed" : "unreachable", msg);
  }
  return new WorkerMailSocket(s);
};
