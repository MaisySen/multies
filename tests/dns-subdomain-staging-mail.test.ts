import { describe, it, expect } from "vitest";
import { StaticResolver } from "@/server/services/dns/resolver";
import { runDnsChecks, fqdnOf } from "@/server/services/dns/checks";
import { loadConfig } from "@/server/config";

// Staging mail (Oct 31): the provider names records for a subdomain relative to the parent zone
// ("send.mail" for mail.example.com). The check looked at send.mail.mail.example.com, never found them,
// and the daily recheck demoted a working sending domain, so sends answered 409 domain_unverified.
describe("fqdnOf", () => {
  it("keeps apex domains as before", () => {
    expect(fqdnOf("send", "acme.io")).toBe("send.acme.io");
    expect(fqdnOf("resend._domainkey", "acme.io")).toBe("resend._domainkey.acme.io");
    expect(fqdnOf("@", "acme.io")).toBe("acme.io");
    expect(fqdnOf("", "acme.io")).toBe("acme.io");
    expect(fqdnOf("acme.io", "acme.io")).toBe("acme.io");
  });
  it("reads provider names relative to the parent zone for a subdomain", () => {
    expect(fqdnOf("send.mail", "mail.example.com")).toBe("send.mail.example.com");
    expect(fqdnOf("resend._domainkey.mail", "mail.example.com")).toBe("resend._domainkey.mail.example.com");
    expect(fqdnOf("mail", "mail.example.com")).toBe("mail.example.com");
    expect(fqdnOf("send.a.b", "a.b.example.com")).toBe("send.a.b.example.com");
    expect(fqdnOf("send.mail", "mail.example.co.uk")).toBe("send.mail.example.co.uk");
  });
  it("still accepts names relative to the domain itself and full names", () => {
    expect(fqdnOf("send", "mail.example.com")).toBe("send.mail.example.com");
    expect(fqdnOf("send.mail.example.com", "mail.example.com")).toBe("send.mail.example.com");
    expect(fqdnOf("send.mail.example.com.", "mail.example.com")).toBe("send.mail.example.com");
  });
});

describe("runDnsChecks on a provider registered subdomain", () => {
  const config = loadConfig({ MAIL_SPF_INCLUDES: "_spf.mx.cloudflare.net" });
  const d = {
    name: "mail.example.com", verificationToken: "tok9", dkimSelector: "mymail", dkimPublicKey: "MIIBKEY",
    providerDomainId: "pd1", providerStatus: "verified",
    providerRecords: JSON.stringify([
      { record: "DKIM", name: "resend._domainkey.mail", type: "TXT", value: "p=PROVIDERKEY", status: "verified" },
      { record: "SPF", name: "send.mail", type: "MX", value: "feedback-smtp.example-ses.com", priority: 10, status: "verified" },
      { record: "SPF", name: "send.mail", type: "TXT", value: "v=spf1 include:amazonses.com ~all", status: "verified" },
    ]),
  };
  it("verifies when the records sit where the provider asked", async () => {
    const dns = new StaticResolver({
      txt: {
        "_multies.mail.example.com": ["multies-verify=tok9"],
        "mail.example.com": ["v=spf1 include:_spf.mx.cloudflare.net ~all"],
        "resend._domainkey.mail.example.com": ["p=PROVIDERKEY"],
        "send.mail.example.com": ["v=spf1 include:amazonses.com ~all"],
        "_dmarc.mail.example.com": ["v=DMARC1; p=none"],
      },
      mx: {
        "mail.example.com": config.mail.mxHosts.map((m) => ({ exchange: m.host, priority: m.priority })),
        "send.mail.example.com": [{ exchange: "feedback-smtp.example-ses.com", priority: 10 }],
      },
    });
    const report = await runDnsChecks(dns, d as never, config, new Date());
    const failed = report.records.filter((r) => r.status === "fail").map((r) => r.id);
    expect(failed).toEqual([]);
    expect(report.verified).toBe(true);
  });
});
