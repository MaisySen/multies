import { describe, expect, it } from "vitest";
import { detectMailProvider } from "@/shared/mail-check";
import { dmarcItem, spfItem, switchSteps, CheckCache } from "@/server/services/mail-check";
import { DnsLookupError, StaticResolver, type DnsResolver } from "@/server/services/dns/resolver";
import { makeTestApp } from "./helpers";

const mx = (...hosts: string[]) => hosts.map((exchange, i) => ({ exchange, priority: (i + 1) * 10 }));

describe("detectMailProvider", () => {
  it("names the common hosts from their MX records", () => {
    expect(detectMailProvider(mx("aspmx.l.google.com", "alt1.aspmx.l.google.com")).id).toBe("google");
    expect(detectMailProvider(mx("smtp.google.com")).id).toBe("google");
    expect(detectMailProvider(mx("acme-io.mail.protection.outlook.com")).id).toBe("microsoft");
    expect(detectMailProvider(mx("mx.zoho.com.au", "mx2.zoho.com.au")).id).toBe("zoho");
    expect(detectMailProvider(mx("in1-smtp.messagingengine.com")).id).toBe("fastmail");
    expect(detectMailProvider(mx("route1.mx.cloudflare.net")).kind).toBe("forwarding");
    expect(detectMailProvider(mx("us-smtp-inbound-1.mimecast.com")).kind).toBe("gateway");
  });
  it("uses the lowest priority host first and ignores a trailing dot", () => {
    expect(detectMailProvider([{ exchange: "backup.example.net", priority: 50 }, { exchange: "ASPMX.L.GOOGLE.COM.", priority: 1 }]).id).toBe("google");
  });
  it("does not match a host that only contains a provider name", () => {
    expect(detectMailProvider(mx("google.com.evil.example")).id).toBe("other");
    expect(detectMailProvider(mx("notgoogle.com")).id).toBe("other");
  });
  it("says when there is no mail host, and when it is already Multies", () => {
    expect(detectMailProvider([]).kind).toBe("none");
    expect(detectMailProvider([{ exchange: ".", priority: 0 }]).kind).toBe("none");
    expect(detectMailProvider(mx("mx1.multies.si"), { multiesOwned: true, multiesMx: ["mx1.multies.si"] }).kind).toBe("multies");
    expect(detectMailProvider(mx("inbound-smtp.us-east-1.amazonaws.com"), { multiesOwned: true }).kind).toBe("multies");
  });
  it("does not call a shared receiving service Multies without the ownership record", () => {
    expect(detectMailProvider(mx("route1.mx.cloudflare.net"), { multiesMx: ["route1.mx.cloudflare.net"] }).id).toBe("cloudflare");
    expect(detectMailProvider(mx("aspmx.l.google.com"), { multiesOwned: true }).id).toBe("google");
  });
});

describe("sender record checks", () => {
  it("grades SPF", () => {
    expect(spfItem([]).status).toBe("fail");
    expect(spfItem(["v=spf1 include:_spf.google.com ~all", "v=spf1 -all"]).status).toBe("fail");
    expect(spfItem(["v=spf1 +all"]).status).toBe("fail");
    expect(spfItem(["v=spf1 include:_spf.google.com"]).status).toBe("warn");
    expect(spfItem(["google-site-verification=x", "v=spf1 include:_spf.google.com ~all"])).toMatchObject({ status: "pass", records: ["v=spf1 include:_spf.google.com ~all"] });
  });
  it("grades DMARC", () => {
    expect(dmarcItem([]).status).toBe("warn");
    expect(dmarcItem(["v=DMARC1; p=none"]).status).toBe("warn");
    expect(dmarcItem(["v=DMARC1; rua=mailto:x@y.z"]).status).toBe("fail");
    expect(dmarcItem(["v=DMARC1; p=reject"]).status).toBe("pass");
  });
});

describe("switchSteps", () => {
  const pass = { status: "pass" as const, records: ["v=spf1 ~all"], message: "" };
  it("orders a Google switch with import, TTL and MX last but one", () => {
    const steps = switchSteps("acme.io", detectMailProvider(mx("aspmx.l.google.com")), pass, { status: "warn", records: [], message: "" });
    expect(steps.map((s) => s.id)).toEqual(["add", "records", "mailboxes", "import", "ttl", "mx", "dmarc"]);
    expect(steps.find((s) => s.id === "import")!.body).toContain("app password");
    expect(steps.find((s) => s.id === "records")!.body).toContain("existing SPF record");
  });
  it("skips import and TTL for a domain with no mail yet", () => {
    const steps = switchSteps("new.io", detectMailProvider([]), { status: "fail", records: [], message: "" }, { status: "warn", records: [], message: "" });
    expect(steps.map((s) => s.id)).toEqual(["add", "records", "mailboxes", "mx", "dmarc"]);
  });
  it("tells forwarding users there is nothing to import, and gateway users to check the filter", () => {
    expect(switchSteps("a.io", detectMailProvider(mx("mx1.improvmx.com")), pass, pass).find((s) => s.id === "import")!.title).toBe("Nothing to import");
    expect(switchSteps("a.io", detectMailProvider(mx("eu-smtp-inbound-1.mimecast.com")), pass, pass).some((s) => s.id === "gateway")).toBe(true);
  });
  it("says a domain on Multies has nothing to move", () => {
    const steps = switchSteps("a.io", detectMailProvider(mx("mx.m.test"), { multiesOwned: true, multiesMx: ["mx.m.test"] }), pass, pass);
    expect(steps.map((s) => s.id)).toEqual(["done"]);
  });
});

describe("CheckCache", () => {
  it("expires entries and stays bounded", () => {
    const c = new CheckCache(1000, 2);
    const v = { domain: "a.io" } as never;
    c.set("a.io", v, 0);
    expect(c.get("a.io", 500)).toBe(v);
    expect(c.get("a.io", 1500)).toBeNull();
    c.set("b.io", v, 0); c.set("c.io", v, 0); c.set("d.io", v, 0);
    expect(c.get("b.io", 0)).toBeNull();
  });
});

describe("GET /api/check/domain", () => {
  it("answers without sign in and writes nothing to the database", async () => {
    const { app, db, dns } = await makeTestApp();
    (dns as StaticResolver).records = {
      mx: { "acme.io": mx("aspmx.l.google.com") },
      txt: { "acme.io": ["v=spf1 include:_spf.google.com ~all"], "_dmarc.acme.io": ["v=DMARC1; p=quarantine"] },
    };
    const changes = () => ((db as unknown as { $client: { prepare: (q: string) => { get: () => unknown } } }).$client.prepare("select total_changes() as n").get() as { n: number }).n;
    const before = changes();
    const res = await app.request("/api/check/domain?domain=ACME.io", { headers: { host: "localhost" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { check: { domain: string; provider: { id: string }; spf: { status: string }; dmarc: { status: string }; steps: unknown[] } };
    expect(body.check).toMatchObject({ domain: "acme.io", provider: { id: "google" }, spf: { status: "pass" }, dmarc: { status: "pass" } });
    expect(body.check.steps.length).toBeGreaterThan(4);
    expect(changes()).toBe(before);
  });
  it("says a domain is on Multies when it has the ownership record and Multies' MX", async () => {
    const { app, dns } = await makeTestApp();
    (dns as StaticResolver).records = { mx: { "acme.io": mx("route1.mx.cloudflare.net") }, txt: { "_mymail.acme.io": ["mymail-verify=tok"] } };
    const body = (await (await app.request("/api/check/domain?domain=acme.io", { headers: { host: "localhost" } })).json()) as { check: { provider: { kind: string }; steps: { id: string }[] } };
    expect(body.check.provider.kind).toBe("multies");
    expect(body.check.steps[0].id).toBe("done");
  });
  it("accepts a pasted URL or email domain form and rejects junk", async () => {
    const { app } = await makeTestApp();
    expect((await app.request("/api/check/domain?domain=https://acme.io/about", { headers: { host: "localhost" } })).status).toBe(200);
    for (const bad of ["", "localhost", "127.0.0.1", "a..b", "x".repeat(260) + ".com"]) {
      const r = await app.request(`/api/check/domain?domain=${encodeURIComponent(bad)}`, { headers: { host: "localhost" } });
      expect(r.status, bad).toBe(422);
    }
  });
  it("answers 502 when DNS can't be reached", async () => {
    const { app, deps } = await makeTestApp();
    const failing: DnsResolver = { txt: async () => { throw new DnsLookupError("down"); }, mx: async () => { throw new DnsLookupError("down"); } };
    deps.dns = failing;
    const r = await app.request("/api/check/domain?domain=acme.io", { headers: { host: "localhost" } });
    expect(r.status).toBe(502);
  });
  it("limits one network to 20 fresh checks a minute", async () => {
    const { app } = await makeTestApp();
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) codes.push((await app.request(`/api/check/domain?domain=d${i}.io`, { headers: { host: "localhost" } })).status);
    expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
    expect(codes[21]).toBe(429);
  });
});
