import { describe, it, expect, beforeEach } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import Papa from "papaparse";
import { makeTestApp, Client } from "./helpers";
import { verifiedDomain } from "./priv1a-world"; // PRIV1b (P36): only a verified domain routes mail
import { deliverInbound } from "@/server/services/mail/delivery";
import { parseMime } from "@/server/services/mail/mime";

describe("privacy: data export and account deletion", () => {
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  let owner: Client;
  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = new Client(ctx.app);
    await owner.signup("owner@example.com");
  });

  async function addMember(role: "member" | "admin" | "owner" = "member") {
    const invite = await owner.post("/api/team/invites", { email: `${role}@example.com`, role });
    const m = new Client(ctx.app);
    await m.signup(`${role}@example.com`, "Teammate", "");
    expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    return m;
  }

  it("gives a person a copy of their own data without secrets", async () => {
    const res = await owner.get("/api/account/export");
    expect(res.status).toBe(200);
    expect(res.body.profile).toMatchObject({ email: "owner@example.com", name: "Ada Lovelace" });
    expect(res.body.security.signInMethods[0].provider).toBe("credential");
    expect(res.body.workspaces[0]).toMatchObject({ workspace: "Acme", role: "owner" });
    expect(JSON.stringify({ ...res.body, notes: "" })).not.toMatch(/password|hash|secret_enc/i);
  });

  it("exports the whole workspace, mail included, as a ZIP", async () => {
    const domainId = await verifiedDomain(ctx, owner, "acme.io");
    await owner.post("/api/mailboxes", { domainId, localPart: "ada", displayName: "Ada" });
    const raw = new TextEncoder().encode("From: bob@example.com\r\nTo: ada@acme.io\r\nSubject: Quarterly numbers\r\n\r\nSee attached\r\n");
    await deliverInbound(ctx.deps, { envelopeFrom: "bob@example.com", rcptTo: "ada@acme.io", email: await parseMime(raw), sizeBytes: raw.length, via: "test", raw });

    const res = await ctx.app.request("/api/account/workspace/export", { headers: { cookie: owner.cookie, host: "localhost" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="multies-workspace-/);
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    // R38: the export also carries the work data (data/*.json, csv/, docs/, calendar/, contacts/), a README and mbox mail.
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["README.txt", "audit-log.csv", "mail/ada@acme.io.jsonl", "mail/ada@acme.io.mbox", "members.csv", "workspace.json", "data/tasks.json", "csv/tasks.csv", "calendar/meetings.ics", "contacts/contacts.vcf"]));
    expect(strFromU8(files["mail/ada@acme.io.mbox"]!)).toMatch(/^From bob@example\.com /);
    const ws = JSON.parse(strFromU8(files["workspace.json"]!));
    expect(ws.workspace.name).toBe("Acme");
    expect(ws.domains[0].name).toBe("acme.io");
    expect(JSON.stringify(ws)).not.toMatch(/dkimPrivateKeyEnc|stripeCustomerId/);
    const mail = strFromU8(files["mail/ada@acme.io.jsonl"]!).trim().split("\n").map((l) => JSON.parse(l));
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ subject: "Quarterly numbers", fromAddress: "bob@example.com" });
    const members = Papa.parse<Record<string, string>>(strFromU8(files["members.csv"]!), { header: true }).data;
    expect(members[0]).toMatchObject({ email: "owner@example.com", role: "owner" });
    // The export itself is audited.
    const audit = await owner.get("/api/org/audit");
    expect(audit.body.entries[0].action).toBe("workspace.exported");
  });

  it("exports the audit log as CSV or JSON for admins only", async () => {
    await owner.post("/api/domains", { name: "acme.io" });
    const csv = await owner.get("/api/org/audit/export");
    expect(csv.status).toBe(200);
    const rows = Papa.parse<Record<string, string>>(csv.body as string, { header: true, skipEmptyLines: true });
    expect(rows.meta.fields).toEqual(["at", "action", "actor", "actorUserId", "targetType", "targetId", "ip", "metadata"]);
    expect(rows.data.some((r) => r.action === "domain.added" || r.action.startsWith("domain."))).toBe(true);
    const json = await owner.get("/api/org/audit/export?format=json&from=2000-01-01");
    expect(Array.isArray(json.body)).toBe(true);
    expect((await owner.get("/api/org/audit/export?format=xml")).status).toBe(422);

    const member = await addMember("member");
    expect((await member.get("/api/org/audit/export")).status).toBe(403);
    expect((await member.get("/api/account/workspace/export")).status).toBe(403);
  });

  it("will not orphan a shared workspace when its only owner deletes their account", async () => {
    const member = await addMember("member");
    const blocked = await owner.post("/api/auth/delete-user", { password: "a-strong-password" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toMatch(/only owner of Acme/);
    // A member can leave freely; the workspace and its owner stay.
    expect((await member.post("/api/auth/delete-user", { password: "a-strong-password" })).status).toBe(200);
    expect(await ctx.db.query.organizations.findMany()).toHaveLength(1);
    expect((await owner.get("/api/account/me")).status).toBe(200);
  });
});
