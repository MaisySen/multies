import { describe, it, expect } from "vitest";
import { StaticResolver, parseTxtData, DohResolver } from "@/server/services/dns/resolver";
import { runDnsChecks, mergeSpf, dkimKeyFrom, expectedRecords } from "@/server/services/dns/checks";
import { loadConfig } from "@/server/config";

const config = loadConfig({});
const d = { name: "acme.io", verificationToken: "tok123", dkimSelector: "mymail", dkimPublicKey: "MIIBKEY" };

function fullyConfigured() {
  return new StaticResolver({
    txt: {
      "_mymail.acme.io": ["mymail-verify=tok123"],
      "acme.io": ["v=spf1 include:_spf.mx.cloudflare.net ~all", "google-site-verification=abc"],
      "mymail._domainkey.acme.io": ["v=DKIM1; k=rsa; p=MIIBKEY"],
      "_dmarc.acme.io": ["v=DMARC1; p=quarantine; rua=mailto:dmarc@acme.io"],
    },
    mx: { "acme.io": config.mail.mxHosts.map((m) => ({ exchange: m.host, priority: m.priority })) },
  });
}

describe("expected records", () => {
  it("covers ownership, MX, SPF, DKIM and DMARC", () => {
    const recs = expectedRecords(d, config);
    expect(recs.map((r) => r.id)).toEqual(["ownership", "mx", "spf", "dkim", "dmarc"]);
    expect(recs.find((r) => r.id === "dkim")!.value).toBe("v=DKIM1; k=rsa; p=MIIBKEY");
    expect(recs.find((r) => r.id === "dkim")!.host).toBe("mymail._domainkey");
  });
});

describe("runDnsChecks", () => {
  it("verifies a correctly configured domain", async () => {
    const r = await runDnsChecks(fullyConfigured(), d, config, new Date());
    expect(r.verified).toBe(true);
    expect(r.records.every((x) => x.status === "pass")).toBe(true);
  });

  it("reports everything missing on a fresh domain", async () => {
    const r = await runDnsChecks(new StaticResolver(), d, config, new Date());
    expect(r.verified).toBe(false);
    expect(Object.fromEntries(r.records.map((x) => [x.id, x.status]))).toEqual({ ownership: "fail", mx: "fail", spf: "fail", dkim: "fail", dmarc: "warn" });
  });

  it("flags duplicate SPF records and suggests a merge", async () => {
    const dns = fullyConfigured();
    dns.records.txt!["acme.io"] = ["v=spf1 include:_spf.google.com ~all", "v=spf1 include:_spf.mx.cloudflare.net ~all"];
    const spf = (await runDnsChecks(dns, d, config, new Date())).records.find((x) => x.id === "spf")!;
    expect(spf.status).toBe("fail");
    expect(spf.suggestion).toBe("v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net ~all");
  });

  it("detects a different DKIM key", async () => {
    const dns = fullyConfigured();
    dns.records.txt!["mymail._domainkey.acme.io"] = ["v=DKIM1; k=rsa; p=OTHERKEY"];
    const r = await runDnsChecks(dns, d, config, new Date());
    expect(r.records.find((x) => x.id === "dkim")!.status).toBe("fail");
    expect(r.verified).toBe(false);
  });

  it("warns on extra MX hosts and p=none, but still verifies", async () => {
    const dns = fullyConfigured();
    dns.records.mx!["acme.io"].push({ exchange: "aspmx.l.google.com", priority: 1 });
    dns.records.txt!["_dmarc.acme.io"] = ["v=DMARC1; p=none"];
    const r = await runDnsChecks(dns, d, config, new Date());
    expect(r.records.find((x) => x.id === "mx")!.status).toBe("warn");
    expect(r.records.find((x) => x.id === "dmarc")!.status).toBe("warn");
    expect(r.verified).toBe(true);
  });

  it("turns resolver failures into retryable errors, not verdicts", async () => {
    const broken = { txt: async () => { throw new Error("SERVFAIL"); }, mx: async () => { throw new Error("SERVFAIL"); } };
    const r = await runDnsChecks(broken, d, config, new Date());
    expect(r.records.every((x) => x.status === "error")).toBe(true);
    expect(r.verified).toBe(false);
  });
});

describe("helpers", () => {
  it("merges SPF without duplicating or keeping +all", () => {
    expect(mergeSpf("v=spf1 include:a.com +all", ["a.com", "b.com"])).toBe("v=spf1 include:a.com include:b.com ~all");
    expect(mergeSpf("v=spf1 mx -all", ["b.com"])).toBe("v=spf1 mx include:b.com -all");
  });
  it("extracts DKIM keys across whitespace and split strings", () => {
    expect(dkimKeyFrom("v=DKIM1; k=rsa; p=AB CD\n EF")).toBe("ABCDEF");
    expect(dkimKeyFrom("v=DKIM1; k=rsa")).toBeNull();
  });
  it("joins DoH TXT character-strings", () => {
    expect(parseTxtData('"v=DKIM1; p=abc" "def"')).toBe("v=DKIM1; p=abcdef");
    expect(parseTxtData('"say \\"hi\\""')).toBe('say "hi"');
  });
});

describe("DoH resolver", () => {
  it("parses answers and treats NXDOMAIN as empty", async () => {
    const fake = (async (url: string) => {
      if (url.includes("nx.example")) return new Response(JSON.stringify({ Status: 3 }));
      if (url.includes("type=MX")) return new Response(JSON.stringify({ Status: 0, Answer: [{ name: "x", type: 15, TTL: 1, data: "10 Route1.MX.Cloudflare.net." }] }));
      return new Response(JSON.stringify({ Status: 0, Answer: [{ name: "x", type: 16, TTL: 1, data: '"v=spf1 " "~all"' }, { name: "x", type: 5, TTL: 1, data: "cname." }] }));
    }) as unknown as typeof fetch;
    const r = new DohResolver(fake, ["https://doh.test/dns-query"]);
    expect(await r.mx("acme.io")).toEqual([{ priority: 10, exchange: "route1.mx.cloudflare.net" }]);
    expect(await r.txt("acme.io")).toEqual(["v=spf1 ~all"]);
    expect(await r.txt("nx.example")).toEqual([]);
  });

  it.skipIf(!process.env.LIVE_DNS)("resolves real records over the internet", async () => {
    const r = new DohResolver();
    expect((await r.mx("gmail.com")).length).toBeGreaterThan(0);
    expect((await r.txt("_dmarc.gmail.com")).some((t) => t.startsWith("v=DMARC1"))).toBe(true);
  });
});
