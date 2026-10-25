/**
 * The Node adapter for MailSocket (the Node server, tests and the local E2E run).
 * `allowSelfSigned` exists for the local test mail server only; config refuses it in production.
 */
import net from "node:net";
import tls from "node:tls";
import { SocketError, type MailSocket, type SocketOpener, type SocketOptions } from "./socket";

class NodeMailSocket implements MailSocket {
  private queue: Uint8Array[] = [];
  private waiters: ((v: Uint8Array | null) => void)[] = [];
  private ended = false;
  private error: Error | null = null;

  constructor(private sock: net.Socket, private host: string, private allowSelfSigned: boolean) {
    sock.on("data", (d: Buffer) => { const w = this.waiters.shift(); if (w) w(new Uint8Array(d)); else this.queue.push(new Uint8Array(d)); });
    sock.on("end", () => this.finish());
    sock.on("close", () => this.finish());
    sock.on("error", (e) => { this.error = e; this.finish(); });
  }

  private finish() {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w(null);
  }

  read(): Promise<Uint8Array | null> {
    const q = this.queue.shift();
    if (q) return Promise.resolve(q);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  write(data: Uint8Array): Promise<void> {
    if (this.ended) return Promise.reject(new SocketError("closed", this.error?.message ?? "The connection is closed."));
    return new Promise((resolve, reject) => this.sock.write(data, (err) => (err ? reject(new SocketError("closed", err.message)) : resolve())));
  }

  startTls(): Promise<MailSocket> {
    this.sock.removeAllListeners("data");
    return new Promise((resolve, reject) => {
      const t = tls.connect({ socket: this.sock, servername: net.isIP(this.host) ? undefined : this.host, rejectUnauthorized: !this.allowSelfSigned });
      t.once("secureConnect", () => resolve(new NodeMailSocket(t, this.host, this.allowSelfSigned)));
      t.once("error", (e) => reject(new SocketError("tls_failed", e.message)));
    });
  }

  async close() { this.sock.destroy(); }
}

export function nodeSocketOpener(opts: { allowSelfSigned?: boolean } = {}): SocketOpener {
  const allowSelfSigned = !!opts.allowSelfSigned;
  return (o: SocketOptions) => new Promise((resolve, reject) => {
    const timeout = o.timeoutMs ?? 15_000;
    const onError = (e: NodeJS.ErrnoException) => {
      const tlsProblem = /certificate|self.signed|SSL|TLS|wrong version/i.test(`${e.code ?? ""} ${e.message}`);
      reject(new SocketError(tlsProblem ? "tls_failed" : "unreachable", e.message));
    };
    const sock = o.security === "tls"
      ? tls.connect({ host: o.host, port: o.port, servername: net.isIP(o.host) ? undefined : o.host, rejectUnauthorized: !allowSelfSigned })
      : net.connect({ host: o.host, port: o.port });
    const timer = setTimeout(() => { sock.destroy(); reject(new SocketError("timeout", `No answer from ${o.host}:${o.port}.`)); }, timeout);
    sock.once("error", (e) => { clearTimeout(timer); onError(e); });
    sock.once(o.security === "tls" ? "secureConnect" : "connect", () => {
      clearTimeout(timer);
      sock.removeAllListeners("error");
      resolve(new NodeMailSocket(sock, o.host, allowSelfSigned));
    });
  });
}
