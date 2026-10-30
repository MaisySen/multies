/**
 * Inbound authentication with mailauth (SPF, DKIM, DMARC, ARC), the library behind
 * WildDuck and EmailEngine. Node only: the Workers build keeps the verdicts the
 * receiving MTA (Cloudflare Email Routing) already wrote into the message.
 */
import { authenticate as mailauth, type DNSResolver } from "mailauth";
import type { AuthResults } from "@/shared/mail";

export interface AuthContextInput { sender?: string; ip?: string; helo?: string; mta?: string }
export type Authenticator = (raw: Uint8Array, ctx: AuthContextInput) => Promise<{ results: AuthResults; header: string }>;

type Verdict = { status?: { result?: string } };
const result = (v: unknown) => ((v as Verdict | false | undefined) || undefined)?.status?.result;

export function mailauthAuthenticator(opts: { resolver?: DNSResolver; mta?: string } = {}): Authenticator {
  return async (raw, ctx) => {
    const res = await mailauth(Buffer.from(raw), {
      sender: ctx.sender, ip: ctx.ip, helo: ctx.helo, mta: ctx.mta ?? opts.mta ?? "mymail",
      resolver: opts.resolver, disableBimi: true, trustReceived: false,
    });
    const dkimResults = (res.dkim?.results ?? []) as Verdict[];
    const dkim = dkimResults.some((r) => r.status?.result === "pass") ? "pass" : dkimResults.length ? "fail" : "none";
    const dmarcRaw = result(res.dmarc);
    const spfRaw = ctx.ip ? result(res.spf) : undefined;
    const results: AuthResults = {
      dkim,
      dmarc: dmarcRaw === "pass" ? "pass" : dmarcRaw === "fail" ? "fail" : "none",
      ...(spfRaw ? { spf: (["pass", "fail", "softfail", "neutral"].includes(spfRaw) ? spfRaw : "none") as AuthResults["spf"] } : {}),
    };
    return { results, header: res.headers ?? "" };
  };
}
