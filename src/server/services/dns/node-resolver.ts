import { promises as dns } from "node:dns";
import { DnsLookupError, type DnsResolver, type MxRecord } from "./resolver";

const EMPTY = new Set(["ENODATA", "ENOTFOUND", "ENOENT"]);

/** Uses the operating system's resolver. Node only. */
export class NodeResolver implements DnsResolver {
  async txt(name: string): Promise<string[]> {
    try {
      return (await dns.resolveTxt(name)).map((chunks) => chunks.join(""));
    } catch (err) {
      if (EMPTY.has((err as NodeJS.ErrnoException).code ?? "")) return [];
      throw new DnsLookupError(String(err));
    }
  }
  async mx(name: string): Promise<MxRecord[]> {
    try {
      return (await dns.resolveMx(name)).map((r) => ({ exchange: r.exchange.toLowerCase().replace(/\.$/, ""), priority: r.priority }));
    } catch (err) {
      if (EMPTY.has((err as NodeJS.ErrnoException).code ?? "")) return [];
      throw new DnsLookupError(String(err));
    }
  }
}
