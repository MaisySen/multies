/**
 * An in-memory stand-in for the parts of Stalwart's JMAP API Multies uses. It checks
 * Basic credentials the way the real server does: admin calls need the provisioner,
 * app password calls must come from the account itself.
 */
type Acct = { id: string; name: string; domainId: string; secret: string; quota?: number; appPasswords: Map<string, { description: string; secret: string }>; inbox: Uint8Array[] };

export function fakeStalwart(admin = { user: "provisioner@ops.test", secret: "admin-secret" }) {
  const domains = new Map<string, string>(); // id -> name
  const accounts = new Map<string, Acct>();
  let seq = 0;
  const id = () => (++seq).toString(36);
  const who = (req: Request) => {
    const h = req.headers.get("authorization") ?? "";
    const [user, secret] = atob(h.replace(/^Basic /, "")).split(":");
    if (user === admin.user && secret === admin.secret) return { admin: true as const };
    for (const a of accounts.values()) {
      const email = `${a.name}@${domains.get(a.domainId)}`;
      if (email === user && a.secret === secret) return { admin: false as const, acct: a };
    }
    return null;
  };
  const calls: string[] = [];

  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const me = who(req);
    if (!me) return new Response("unauthorized", { status: 401 });
    if (url.pathname === "/api/account") return Response.json({ edition: "oss", permissions: [] });
    if (url.pathname === "/jmap/session") return Response.json({ primaryAccounts: { "urn:ietf:params:jmap:mail": me.admin ? "admin" : me.acct.id } });
    if (url.pathname.startsWith("/jmap/upload/")) {
      const bytes = new Uint8Array(await req.arrayBuffer());
      const blobId = `blob-${id()}`;
      blobs.set(blobId, bytes);
      return Response.json({ blobId, size: bytes.length });
    }
    if (url.pathname !== "/jmap/") return new Response("nope", { status: 404 });
    const body = (await req.json()) as { methodCalls: [string, Record<string, unknown>, string][] };
    const out: unknown[] = [];
    for (const [name, args, tag] of body.methodCalls) {
      calls.push(name);
      const adminOnly = name.startsWith("x:Domain") || name.startsWith("x:Account");
      if (adminOnly && !me.admin) { out.push(["error", { type: "forbidden" }, tag]); continue; }
      if (name === "x:Domain/query") {
        const f = (args.filter as { name?: string }) ?? {};
        out.push([name, { ids: [...domains].filter(([, n]) => !f.name || n === f.name).map(([i]) => i) }, tag]);
      } else if (name === "x:Domain/set") {
        const created: Record<string, unknown> = {};
        for (const [k, v] of Object.entries((args.create ?? {}) as Record<string, { name: string }>)) { const i = id(); domains.set(i, v.name); created[k] = { id: i }; }
        out.push([name, { created }, tag]);
      } else if (name === "x:Account/query") {
        const f = (args.filter as { name?: string; domainId?: string }) ?? {};
        out.push([name, { ids: [...accounts.values()].filter((a) => (!f.name || a.name === f.name) && (!f.domainId || a.domainId === f.domainId)).map((a) => a.id) }, tag]);
      } else if (name === "x:Account/set") {
        const created: Record<string, unknown> = {}; const destroyed: string[] = []; const notDestroyed: Record<string, unknown> = {};
        for (const [k, v] of Object.entries((args.create ?? {}) as Record<string, { name: string; domainId: string; credentials: Record<string, { secret: string }>; quotas: { maxDiskQuota?: number } }>)) {
          const i = id();
          accounts.set(i, { id: i, name: v.name, domainId: v.domainId, secret: v.credentials["0"].secret, quota: v.quotas.maxDiskQuota, appPasswords: new Map(), inbox: [] });
          created[k] = { id: i };
        }
        for (const [k, v] of Object.entries((args.update ?? {}) as Record<string, { quotas?: { maxDiskQuota?: number }; credentials?: Record<string, { secret: string }> }>)) {
          const a = accounts.get(k);
          if (a && v.quotas) a.quota = v.quotas.maxDiskQuota;
          if (a && v.credentials) a.secret = v.credentials["0"].secret;
        }
        for (const d of (args.destroy ?? []) as string[]) { if (accounts.delete(d)) destroyed.push(d); else notDestroyed[d] = { type: "notFound" }; }
        out.push([name, { created, destroyed, notDestroyed }, tag]);
      } else if (name === "x:AppPassword/set") {
        if (me.admin) { out.push(["error", { type: "forbidden" }, tag]); continue; }
        const created: Record<string, unknown> = {}; const destroyed: string[] = [];
        for (const [k, v] of Object.entries((args.create ?? {}) as Record<string, { description: string }>)) {
          const i = id(); const secret = `app_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
          me.acct.appPasswords.set(i, { description: v.description, secret }); created[k] = { id: i, secret };
        }
        for (const d of (args.destroy ?? []) as string[]) if (me.acct.appPasswords.delete(d)) destroyed.push(d);
        out.push([name, { created, destroyed }, tag]);
      } else if (name === "Mailbox/query") {
        out.push([name, { ids: ["inbox-1"] }, tag]);
      } else if (name === "Email/import") {
        if (me.admin) { out.push(["error", { type: "forbidden" }, tag]); continue; }
        const e = (args.emails as Record<string, { blobId: string }>).e;
        me.acct.inbox.push(blobs.get(e.blobId)!);
        out.push([name, { created: { e: { id: `m-${id()}` } } }, tag]);
      } else {
        out.push(["error", { type: "unknownMethod" }, tag]);
      }
    }
    return Response.json({ methodResponses: out });
  };
  const blobs = new Map<string, Uint8Array>();
  return { fetch: handler as typeof fetch, accounts, domains, calls, admin, env: { STALWART_URL: "https://mail.ops.test", STALWART_ADMIN_USER: admin.user, STALWART_ADMIN_SECRET: admin.secret } };
}
