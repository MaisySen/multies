/**
 * A plain TCP or TLS connection, the same shape on Workers (cloudflare:sockets) and Node
 * (node:net and node:tls), so the SMTP client runs unchanged on both. The adapters live in
 * src/entry/worker-socket.ts and src/server/services/connect/node-socket.ts.
 */

export interface MailSocket {
  /** The next chunk from the server, or null once it has closed. */
  read(): Promise<Uint8Array | null>;
  write(data: Uint8Array): Promise<void>;
  /** Upgrades this connection to TLS (STARTTLS) and returns the new socket. */
  startTls(): Promise<MailSocket>;
  close(): Promise<void>;
}

export interface SocketOptions {
  host: string;
  port: number;
  /** "tls": TLS from the first byte. "starttls": plain, upgraded after the server says so. */
  security: "tls" | "starttls";
  timeoutMs?: number;
}

export type SocketOpener = (opts: SocketOptions) => Promise<MailSocket>;

/** Thrown when a connection could not be made or broke; `kind` drives the message a person sees. */
export class SocketError extends Error {
  constructor(public kind: "unreachable" | "tls_failed" | "timeout" | "closed", message: string) {
    super(message);
    this.name = "SocketError";
  }
}

/** Reads CRLF terminated lines from a socket, keeping what is left over for the next read. */
export class LineReader {
  private buf = "";
  private dec = new TextDecoder();
  constructor(public socket: MailSocket, private timeoutMs = 20_000) {}

  /** Swaps the underlying socket after STARTTLS; whatever was buffered is dropped (RFC 3207). */
  reset(socket: MailSocket) { this.socket = socket; this.buf = ""; this.dec = new TextDecoder(); }

  async line(): Promise<string> {
    for (;;) {
      const i = this.buf.indexOf("\n");
      if (i >= 0) {
        const l = this.buf.slice(0, i).replace(/\r$/, "");
        this.buf = this.buf.slice(i + 1);
        return l;
      }
      const chunk = await withTimeout(this.socket.read(), this.timeoutMs);
      if (chunk === null) throw new SocketError("closed", "The server closed the connection.");
      this.buf += this.dec.decode(chunk, { stream: true });
      if (this.buf.length > 1_000_000) throw new SocketError("closed", "The server sent a line that is far too long.");
    }
  }
}

export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => { t = setTimeout(() => reject(new SocketError("timeout", "The server took too long to answer.")), ms); })]);
  } finally {
    if (t) clearTimeout(t);
  }
}
