import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { attachments, mailboxes, messages, organizations, users } from "@/server/db/schema";
import { createConnection } from "@/server/services/connect";
import { deliverInbound } from "@/server/services/mail/delivery";
import { createEndpoint } from "@/server/services/developer/webhooks";

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

/** PRIV1b (F30): the flag gated surfaces PRIV1a changed (archive, doc inbox, one inbox, mentions, Ask), so they answer instead of 404. */
export const PRIV_FLAGS = { MAIL_ARCHIVE_R111: "on", DOC_INBOX_R102: "on", FILES_PLUS_R101: "on", INBOX_TD6: "on", MENTIONS_TD5: "on", ASK_R110: "on", FREE_MAIL_DOMAIN: "free.example" };

/** PRIV1b (F29): an inbound message as the provider hands it over, with one attachment. */
export const inboundMail = (to: string, from: string, subject: string, text: string, attachment?: { filename: string; content: string }) => ({
  envelopeFrom: from, rcptTo: to, sizeBytes: 400, via: "test",
  email: { messageId: `<${Math.random().toString(36).slice(2)}@x.example.com>`, from: { address: from, name: "Secret" }, to: [{ address: to }], cc: [], subject, text, date: new Date(),
    attachments: attachment ? [{ filename: attachment.filename, contentType: "application/pdf", content: new TextEncoder().encode(attachment.content) }] : [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
}) as never;

/**
 * One workspace: owner Olive, admin Ada, member Max (granted the team mailbox), Pat (owns a personal mailbox), three people Pat shares with, and Nia (no grant).
 * PRIV1b (F29, F30): `flags` turns on PRIV_FLAGS; `real` also gives Pat a free address claimed through the app and a Gmail
 * connected through createConnection, and delivers mail into Pat's and Ada's personal mailboxes through deliverInbound (with a workspace webhook
 * listening), so the product's own flows, not hand written rows, decide those mailboxes are personal.
 */
export async function privacyWorld(opts: { flags?: boolean; real?: boolean; env?: Record<string, string>; fetch?: typeof fetch } = {}) {
  const ctx = await makeTestApp({ ...(opts.flags || opts.real ? PRIV_FLAGS : {}), ...opts.env }, opts.fetch ? { fetch: opts.fetch } : {});
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
  const thread = `thr_pers${n}aaaaaaaaaa`;
  const base = { ctx, n, orgId, domainId, owner, admin, member, pat, dRead, dReply, dSend, nobody, outsider, boxes: { personal, team, agent }, msgs, attId, thread };
  if (!opts.real) return { ...base, real: null };
  // PRIV1b (F29): the real flows. Ada (claiming takes an admin) claims a free address in the app: her personal mailbox,
  // closed to the workspace owner. Pat connects a Gmail (OAuth, so nothing is dialled).
  const claim = await admin.c.post("/api/free-address", { localPart: `ada.free${n}` });
  if (claim.status !== 201) throw new Error(`claim ${claim.status} ${JSON.stringify(claim.body)}`);
  const claimed = claim.body.mailbox as { id: string; address: string };
  const gmail = `pat.gmail${n}@gmail.example`;
  const conn = await createConnection(ctx.deps, { orgId, userId: pat.id, email: `pat${n}@acme.io`, name: "Pat Person", role: "member", emailVerified: true } as never, { email: gmail, password: "", preset: "gmail" } as never, { secret: "tok", authKind: "oauth" });
  await createEndpoint(ctx.deps, orgId, { url: "https://example.com/hook", events: ["message.received"] });
  const words = { subject: `REALSUBJ-${n}`, body: `REALBODY-${n}`, file: `realfile${n}.pdf`, from: `real.sender${n}@private.example` };
  const adaWords = { subject: `ADASUBJ-${n}`, body: `ADABODY-${n}`, file: `adafile${n}.pdf`, from: `ada.sender${n}@private.example` };
  const got = [] as string[];
  // Connected mail arrives by IMAP sync, not deliverInbound: Pat's mail is delivered to her acme.io personal address instead.
  for (const [to, x] of [[`pat.private${n}@acme.io`, words], [claimed.address, adaWords]] as const) {
    const r = await deliverInbound(ctx.deps, inboundMail(to, x.from, x.subject, x.body, { filename: x.file, content: `BYTES-${x.subject}` }));
    if (!r.accepted) throw new Error(`deliver ${to} ${r.reason}`);
    got.push(...r.storedIn);
  }
  const sel = async (x: typeof words) => ({
    msgs: await ctx.db.select({ id: messages.id, threadId: messages.threadId, mailboxId: messages.mailboxId }).from(messages).where(eq(messages.subject, x.subject)).all(),
    attIds: (await ctx.db.select({ id: attachments.id }).from(attachments).where(eq(attachments.filename, x.file)).all()).map((a) => a.id),
  });
  return { ...base, real: { claimed: claimed.id, connected: conn.mailboxId, connectionId: conn.id, stored: got, pat: await sel(words), ada: await sel(adaWords), words, adaWords } };
}
