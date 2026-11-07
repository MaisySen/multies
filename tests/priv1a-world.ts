import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { attachments, mailboxes, messages, organizations, users } from "@/server/db/schema";

type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
let seq = 0;
let ipSeq = 0;
/** A client with its own address, so a cast of nine signs up under the per address sign up limit. */
class IpClient extends Client {
  ip = `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
  override call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return super.call(method, path, body, { "cf-connecting-ip": this.ip, ...headers });
  }
}

export async function verifiedDomain(ctx: Ctx, c: Client, name: string) {
  const domainId = (await c.post("/api/domains", { name })).body.domain.id;
  const { body } = await c.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  await c.post(`/api/domains/${domainId}/verify`);
  return domainId as string;
}

/** One workspace: owner Olive, admin Ada, member Max (granted the team mailbox), Pat (owns a personal mailbox), three people Pat shares with, and Nia (no grant). */
export async function privacyWorld() {
  const ctx = await makeTestApp({});
  const n = ++seq;
  const owner = new IpClient(ctx.app);
  await owner.signup(`olive${n}@acme.io`, "Olive Owner");
  const orgId = (await owner.get("/api/account/me")).body.organization.id as string;
  await ctx.db.update(organizations).set({ plan: "business" }).where(eq(organizations.id, orgId)); // seats for the cast
  const domainId = await verifiedDomain(ctx, owner, "acme.io");
  const team = (await owner.post("/api/mailboxes", { domainId, localPart: "team", displayName: "Team" })).body.mailbox.id as string;
  const join = async (email: string, name: string, role: "admin" | "member", mailboxIds: string[] = []) => {
    const inv = await owner.post("/api/team/invites", { email, role, mailboxIds });
    if (inv.status !== 201) throw new Error(`invite ${inv.status} ${JSON.stringify(inv.body)}`);
    const c = new IpClient(ctx.app);
    await c.signup(email, name, "");
    const acc = await c.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`);
    if (acc.status !== 200) throw new Error(`accept ${acc.status}`);
    const id = (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, email)).get())!.id;
    return { c, id };
  };
  const admin = await join(`ada${n}@acme.io`, "Ada Admin", "admin");
  const member = await join(`max${n}@acme.io`, "Max Member", "member", [team]);
  const pat = await join(`pat${n}@acme.io`, "Pat Person", "member");
  const dRead = await join(`rae${n}@acme.io`, "Rae Read", "member");
  const dReply = await join(`rex${n}@acme.io`, "Rex Reply", "member");
  const dSend = await join(`sam${n}@acme.io`, "Sam Send", "member");
  const nobody = await join(`nia${n}@acme.io`, "Nia Nobody", "member");
  const outsider = new IpClient(ctx.app);
  await outsider.signup(`out${n}@other.io`, "Otto Outsider", "Other");
  // Pat's connected Gmail (personal), and an agent inbox. Rows as the connect and agent flows write them.
  const personal = `mbx_pat${n}personal0`;
  const agent = `mbx_agent${n}inbox000`;
  await ctx.db.insert(mailboxes).values([
    { id: personal, orgId, domainId, localPart: `pat.private${n}`, address: `pat.private${n}@acme.io`, displayName: "Pat (connected)", quotaMb: 100, personal: true, ownerUserId: pat.id },
    { id: agent, orgId, domainId, localPart: `bot${n}`, address: `bot${n}@acme.io`, displayName: "Bot", quotaMb: 100, kind: "agent" },
  ]);
  const mail = async (mailboxId: string, tag: string) => {
    const id = `msg_${tag}${n}aaaaaaaaaa`;
    await ctx.db.insert(messages).values({ id, orgId, mailboxId, folder: "inbox", threadId: `thr_${tag}${n}aaaaaaaaaa`, fromAddress: `secret.sender.${tag}@private.example`, fromName: "Secret",
      to: JSON.stringify([{ name: "", address: "x@acme.io" }]), subject: `SUBJECT-${tag.toUpperCase()}-${n}`, text: `body ${tag}`, snippet: `SNIPPET-${tag}-${n}`, date: new Date(Date.now() - 3_600_000), isRead: false });
    return id;
  };
  const msgs = { personal: await mail(personal, "pers"), team: await mail(team, "team"), agent: await mail(agent, "agnt") };
  const attId = `att_pers${n}aaaaaaaaaa`;
  await ctx.db.insert(attachments).values({ id: attId, messageId: msgs.personal, filename: "secret.pdf", contentType: "application/pdf", sizeBytes: 3, contentB64: "YWJj" } as never);
  for (const [who, level] of [[dRead, "read"], [dReply, "reply"], [dSend, "send_as"]] as const) {
    const r = await pat.c.put(`/api/mailboxes/${personal}/sharing/${who.id}`, { level });
    if (r.status !== 200) throw new Error(`share ${r.status} ${JSON.stringify(r.body)}`);
  }
  return { ctx, n, orgId, domainId, owner, admin, member, pat, dRead, dReply, dSend, nobody, outsider, boxes: { personal, team, agent }, msgs, attId };
}
