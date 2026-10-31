import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { StaticResolver } from "@/server/services/dns/resolver";
import { expectedRecords, runDnsChecks, isVerifyValue } from "@/server/services/dns/checks";
import { checkDomainMail } from "@/server/services/mail-check";
import { loadConfig } from "@/server/config";
import { setting, targetFor, copyFor, type Env } from "../email-worker/src/index";
import { findIssues } from "../scripts/check-copy";
import { isWorkersDevHost, withRobotsHeader } from "@/server/lib/robots-host";

/** R81B: the product is Multies everywhere a person can see it; older records keep working. */
const config = loadConfig({});
const d = { name: "acme.io", verificationToken: "tok123", dkimSelector: "mymail", dkimPublicKey: "MIIBKEY" };

describe("ownership record uses the Multies name", () => {
  it("asks new domains for _multies with a multies-verify value", () => {
    const own = expectedRecords(d, config).find((r) => r.id === "ownership")!;
    expect(own.host).toBe("_multies");
    expect(own.fqdn).toBe("_multies.acme.io");
    expect(own.value).toBe("multies-verify=tok123");
  });

  it("passes with the new record", async () => {
    const r = await runDnsChecks(new StaticResolver({ txt: { "_multies.acme.io": ["multies-verify=tok123"] } }), d, config, new Date());
    expect(r.records.find((x) => x.id === "ownership")!.status).toBe("pass");
  });

  it("still passes for a domain verified before the rename", async () => {
    const r = await runDnsChecks(new StaticResolver({ txt: { "_mymail.acme.io": ["mymail-verify=tok123"] } }), d, config, new Date());
    expect(r.records.find((x) => x.id === "ownership")!.status).toBe("pass");
  });

  it("says the token is wrong for either name", async () => {
    const r = await runDnsChecks(new StaticResolver({ txt: { "_multies.acme.io": ["multies-verify=other"] } }), d, config, new Date());
    expect(r.records.find((x) => x.id === "ownership")!.message).toMatch(/token doesn't match/);
    expect(isVerifyValue("mymail-verify=x")).toBe(true);
    expect(isVerifyValue("google-site-verification=x")).toBe(false);
  });

  it("the mail check sees a Multies owned domain under either name", async () => {
    for (const txt of [{ "_multies.acme.io": ["multies-verify=t"] }, { "_mymail.acme.io": ["mymail-verify=t"] }] as Record<string, string[]>[]) {
      const res = await checkDomainMail(new StaticResolver({ mx: { "acme.io": [{ exchange: "route1.mx.cloudflare.net", priority: 10 }] }, txt }), config, "acme.io", new Date());
      expect(res.provider.kind).toBe("multies");
    }
  });
});

describe("email worker settings", () => {
  it("reads MULTIES_* first and the older names as a fallback", () => {
    const env: Env = { MULTIES_WEBHOOK_URL: "https://new/api/inbound/cloudflare", MYMAIL_WEBHOOK_URL: "https://old/api/inbound/cloudflare", MYMAIL_KEY_ID: "ink_old", MULTIES_KEY_SECRET: "s_new" };
    expect(setting(env, "WEBHOOK_URL")).toBe("https://new/api/inbound/cloudflare");
    expect(targetFor(env, "a@b.test")).toEqual({ url: "https://new/api/inbound/cloudflare", keyId: "ink_old", secret: "s_new" });
  });
  it("keeps a worker deployed with only the old names working", () => {
    const env: Env = { MYMAIL_WEBHOOK_URL: "https://h/api/inbound/cloudflare", MYMAIL_KEY_ID: "ink_1", MYMAIL_KEY_SECRET: "s1", MYMAIL_COPY_TO: JSON.stringify({ "support@multies.si": "x@example.com" }) };
    expect(targetFor(env, "support@multies.si").keyId).toBe("ink_1");
    expect(copyFor(env, "support@multies.si")).toBe("x@example.com");
    expect(copyFor({ MULTIES_KEY_ID: "k" }, "support@multies.si")).toBeNull();
  });
});

describe("copy lint catches the old names in words people read", () => {
  it("flags MyMail, My Mail and MailForge in user facing files only", () => {
    expect(findIssues("src/web/pages/x.tsx", "Welcome to MailForge").map((i) => i.rule)).toContain("name");
    expect(findIssues("src/web/pages/x.tsx", "Open My Mail").map((i) => i.rule)).toContain("name");
    expect(findIssues("docs/x.md", "MyMail is great").map((i) => i.rule)).toContain("name");
    expect(findIssues("src/server/lib/x.ts", "const X = 'MyMail'")).toHaveLength(0);
  });
});

describe("the workers.dev address is never indexed", () => {
  it("marks *.workers.dev only", () => {
    expect(isWorkersDevHost("https://mymail.mymail-app.workers.dev/pricing")).toBe(true);
    expect(isWorkersDevHost("https://multies.si/pricing")).toBe(false);
  });
  it("adds X-Robots-Tag and keeps the body and status", async () => {
    const res = withRobotsHeader(new Response("hi", { status: 200, headers: { "content-type": "text/html" } }));
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(await res.text()).toBe("hi");
  });
  it("the worker wires it for production only and leaves robots.txt alone", () => {
    const src = readFileSync("src/entry/worker.ts", "utf8");
    expect(src).toContain("if (!noindex) return isWorkersDevHost(request.url) ? withRobotsHeader(await next()) : next();");
  });
});
