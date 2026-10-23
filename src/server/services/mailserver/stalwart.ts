/**
 * A small client for Stalwart's management and mail APIs (JMAP over HTTP, v0.16+).
 * Stalwart is the open-source mail server MyMail uses for IMAP and SMTP access
 * (Outlook, Apple Mail, Thunderbird, phones). Everything here is plain fetch, so it
 * runs on Workers and Node alike.
 *
 * Admin calls use the provisioner account. App passwords are a per-account object
 * in Stalwart that only the account itself may create, so those calls authenticate
 * as the mailbox's own server account with the secret MyMail keeps for it.
 */

const CORE = "urn:ietf:params:jmap:core";
const ADMIN = "urn:stalwart:jmap";
const MAIL = "urn:ietf:params:jmap:mail";

export interface Credentials { user: string; secret: string }

type MethodCall = [string, Record<string, unknown>, string];
type MethodResponse = [string, Record<string, unknown>, string];

export class StalwartError extends Error {
  constructor(message: string, readonly status?: number, readonly detail?: unknown) { super(message); }
}

export interface StalwartOptions {
  url: string;
  admin: Credentials;
  fetch: typeof fetch;
}

function basic({ user, secret }: Credentials): string {
  const bytes = new TextEncoder().encode(`${user}:${secret}`);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

export class StalwartClient {
  private readonly base: string;
  constructor(private readonly opts: StalwartOptions) {
    this.base = opts.url.replace(/\/$/, "");
  }

  private async request(path: string, init: RequestInit & { as?: Credentials }): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", basic(init.as ?? this.opts.admin));
    let res: Response;
    try {
      res = await this.opts.fetch(`${this.base}${path}`, { ...init, headers });
    } catch (e) {
      throw new StalwartError(`Mail server unreachable: ${(e as Error).message}`);
    }
    if (res.status === 401) throw new StalwartError("Mail server rejected the credentials.", 401);
    if (!res.ok) throw new StalwartError(`Mail server answered ${res.status}.`, res.status, await res.text().catch(() => ""));
    return res;
  }

  /** Runs JMAP method calls and returns the responses in order. Method-level errors throw. */
  async call(calls: MethodCall[], opts: { as?: Credentials; using?: string[] } = {}): Promise<MethodResponse[]> {
    const res = await this.request("/jmap/", {
      method: "POST",
      as: opts.as,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ using: opts.using ?? [CORE, ADMIN], methodCalls: calls }),
    });
    const body = (await res.json()) as { methodResponses?: MethodResponse[] };
    const out = body.methodResponses ?? [];
    for (const [name, args] of out) {
      if (name === "error") throw new StalwartError(`Mail server error: ${String(args.type)}${args.description ? ` (${String(args.description)})` : ""}`, undefined, args);
    }
    return out;
  }

  static created(resp: MethodResponse, key: string): Record<string, unknown> {
    const args = resp[1] as { created?: Record<string, Record<string, unknown>>; notCreated?: Record<string, { type?: string; description?: string; properties?: string[] }> };
    const made = args.created?.[key];
    if (made) return made;
    const why = args.notCreated?.[key];
    throw new StalwartError(`Mail server refused to create it: ${why?.type ?? "unknown"}${why?.description ? ` (${why.description})` : ""}${why?.properties ? ` [${why.properties.join(", ")}]` : ""}`, undefined, why);
  }

  static destroyed(resp: MethodResponse, id: string) {
    const args = resp[1] as { destroyed?: string[]; notDestroyed?: Record<string, { type?: string }> };
    if (args.destroyed?.includes(id)) return;
    const why = args.notDestroyed?.[id];
    if (why?.type === "notFound") return; // already gone
    throw new StalwartError(`Mail server refused to delete it: ${why?.type ?? "unknown"}`, undefined, why);
  }

  /** Who the admin credentials belong to, for a health check. */
  async ping(): Promise<{ edition: string }> {
    const res = await this.request("/api/account", { method: "GET" });
    const body = (await res.json()) as { edition?: string };
    return { edition: body.edition ?? "unknown" };
  }

  async findDomain(name: string): Promise<string | null> {
    const [r] = await this.call([["x:Domain/query", { filter: { name } }, "q"]]);
    const ids = (r[1].ids as string[] | undefined) ?? [];
    return ids[0] ?? null;
  }

  /** Returns the domain's id, creating it when missing. Idempotent. */
  async ensureDomain(name: string): Promise<string> {
    const found = await this.findDomain(name);
    if (found) return found;
    const [r] = await this.call([["x:Domain/set", { create: { d: { name } } }, "s"]]);
    return String(StalwartClient.created(r, "d").id);
  }

  async findAccount(localPart: string, domainId: string): Promise<string | null> {
    const [r] = await this.call([["x:Account/query", { filter: { name: localPart, domainId } }, "q"]]);
    return ((r[1].ids as string[] | undefined) ?? [])[0] ?? null;
  }

  async createUser(input: { localPart: string; domainId: string; secret: string; quotaBytes?: number; description?: string }): Promise<string> {
    const user = {
      "@type": "User",
      name: input.localPart,
      domainId: input.domainId,
      description: input.description ?? null,
      credentials: { 0: { "@type": "Password", secret: input.secret } },
      memberGroupIds: {},
      roles: { "@type": "User" },
      permissions: { "@type": "Inherit" },
      quotas: input.quotaBytes ? { maxDiskQuota: input.quotaBytes } : {},
      aliases: {},
      encryptionAtRest: { "@type": "Disabled" },
    };
    const [r] = await this.call([["x:Account/set", { create: { u: user } }, "s"]]);
    return String(StalwartClient.created(r, "u").id);
  }

  async setUserQuota(accountId: string, quotaBytes: number) {
    await this.call([["x:Account/set", { update: { [accountId]: { quotas: { maxDiskQuota: quotaBytes } } } }, "s"]]);
  }

  async destroyAccount(accountId: string) {
    const [r] = await this.call([["x:Account/set", { destroy: [accountId] }, "s"]]);
    StalwartClient.destroyed(r, accountId);
  }

  async createAppPassword(as: Credentials, description: string, expiresAt?: Date): Promise<{ id: string; secret: string }> {
    const [r] = await this.call([["x:AppPassword/set", {
      create: { a: { description, permissions: { "@type": "Inherit" }, allowedIps: {}, expiresAt: expiresAt ? expiresAt.toISOString().replace(/\.\d+Z$/, "Z") : null } },
    }, "s"]], { as });
    const made = StalwartClient.created(r, "a");
    return { id: String(made.id), secret: String(made.secret) };
  }

  async listAppPasswords(as: Credentials): Promise<{ id: string; description: string; createdAt: string }[]> {
    const [r] = await this.call([["x:AppPassword/get", { ids: null }, "g"]], { as });
    return ((r[1].list as Record<string, unknown>[] | undefined) ?? []).map((p) => ({ id: String(p.id), description: String(p.description ?? ""), createdAt: String(p.createdAt ?? "") }));
  }

  async destroyAppPassword(as: Credentials, id: string) {
    const [r] = await this.call([["x:AppPassword/set", { destroy: [id] }, "s"]], { as });
    StalwartClient.destroyed(r, id);
  }

  /** Puts a raw RFC 5322 message into the account's inbox (JMAP blob upload, then Email/import). */
  async importToInbox(as: Credentials, raw: Uint8Array, opts: { spam?: boolean } = {}): Promise<string> {
    const session = (await (await this.request("/jmap/session", { method: "GET", as })).json()) as { primaryAccounts?: Record<string, string> };
    const accountId = session.primaryAccounts?.[MAIL];
    if (!accountId) throw new StalwartError("Mail server account has no mail access.");
    const up = (await (await this.request(`/jmap/upload/${encodeURIComponent(accountId)}/`, {
      method: "POST", as, headers: { "content-type": "message/rfc822" }, body: raw as unknown as BodyInit,
    })).json()) as { blobId: string };
    const role = opts.spam ? "junk" : "inbox";
    const [q] = await this.call([["Mailbox/query", { accountId, filter: { role } }, "m"]], { as, using: [CORE, MAIL] });
    const mailboxId = ((q[1].ids as string[] | undefined) ?? [])[0];
    if (!mailboxId) throw new StalwartError(`Mail server account has no ${role} folder.`);
    const [imp] = await this.call([["Email/import", { accountId, emails: { e: { blobId: up.blobId, mailboxIds: { [mailboxId]: true }, keywords: {} } } }, "i"]], { as, using: [CORE, MAIL] });
    return String(StalwartClient.created(imp, "e").id);
  }
}
