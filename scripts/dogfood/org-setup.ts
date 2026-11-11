/* eslint-disable @typescript-eslint/no-explicit-any -- untyped JSON answers from the API; the OpenAPI document is the contract */
/**
 * Org setup for dogfooding: builds a whole company inside a Multies workspace from one
 * config file, so the team that builds the product runs on it for real.
 *
 * Idempotent: every item is found by name first and only created when missing, so a re-run
 * costs a handful of reads and no writes. It talks to the public REST API (/api/v1) with a
 * workspace API key. Creating the workspace and minting its first key are sign up steps and
 * use the app API with a session (sign in, create the workspace, mint the first key); invites
 * go through POST /api/v1/invites since R25 (DF-7) and carry the person's title.
 *
 * Usage:
 *   ORG_PASSWORD=... npx tsx scripts/dogfood/org-setup.ts --config scripts/dogfood/example-org.json \
 *     --base http://localhost:8796 [--state /path/state.json] [--merge scripts/dogfood/findings.json] [--dry-run] [--send-invites]
 *
 * --dry-run reads only and prints every call it would make, then an estimate of the database rows
 * the run would cost against the server's daily write budget. With ORG_SESSION_COOKIE and
 * ORG_API_KEY set it writes nothing at all (a password sign in adds one session row).
 * --max-writes N (default 400) stops a live run before more create or update calls than that; a
 * re-run continues where it stopped. --skip docs,templates leaves whole steps out
 * (projects, channels, goals, docs, meetings, templates).
 *
 * --merge adds more config files on top (comma separated): lists are appended, and a project
 * with the same name gets the extra tasks. findings.json files the dogfood findings as tasks.
 *
 * Secrets: the founder password comes from ORG_PASSWORD. Keys the run mints (the workspace key
 * and one key per agent) are written to the state file (mode 600, outside the repo by default)
 * and never printed. Pass ORG_API_KEY to reuse a workspace key you already hold.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------- config shape
export type Ref = string; // "agent:<key>", "member:self" or "member:<email>"
export interface OrgConfig {
  workspace: { name: string; timezone?: string; domain?: string };
  founder: { name: string; email: string; title?: string };
  /** Real invite emails. Sent only with --send-invites. role: admin or member. */
  invites?: { email: string; role: "admin" | "member"; name?: string; title?: string; note?: string }[];
  /** inbox: true makes a mail agent with an address (counts toward agent inboxes); otherwise an agent member. */
  agents?: { key: string; name: string; title: string; bio: string; inbox?: boolean; localPart?: string; approvalMode?: "always" | "external" | "never" }[];
  channels?: { name: string; purpose: string; welcome?: string; welcomeBy?: Ref }[];
  projects?: {
    name: string; key?: string; color?: string; description?: string; owner?: Ref;
    tasks?: { title: string; notes?: string; priority?: "none" | "low" | "medium" | "high" | "urgent"; due?: string; assignee?: Ref; labels?: string[]; status?: "todo" | "doing" | "done" }[];
  }[];
  goals?: { name: string; description?: string; due?: string; keyResults?: { name: string; kind?: "number" | "currency" | "percent" | "tasks"; start?: number; target?: number; current?: number; unit?: string; project?: string }[] }[];
  docs?: { title: string; text: string; project?: string }[];
  meetings?: { title: string; weekday: number; time: string; timezone: string; durationMin?: number; invitees?: string[]; prepTask?: { project: string; assignee?: Ref } }[];
  /** kind task (default) or doc; for a doc, notes is the body. project is kept for older configs and no longer used. */
  templates?: { name: string; kind?: "task" | "doc"; description?: string; category?: string; project?: string; title: string; notes: string }[];
}

// ---------------------------------------------------------------- write estimate
/**
 * Database rows one API call costs, roughly (the item itself, its activity line, its audit row,
 * labels and members it brings), read off the routes' inserts on 25 Oct 2026 and checked against
 * a local run of example-org.json (64 calls wrote 180 rows; a re-run wrote 1, its sign in session). Enough to see whether a run fits in the day's write budget.
 */
export const ROW_COST: Record<string, number> = {
  workspace: 4, key: 2, agent: 5, invite: 2, domain: 3, project: 3, task: 3, channel: 3, message: 2, pin: 1,
  goal: 2, keyResult: 2, doc: 3, meeting: 3, template: 2, update: 2, other: 4,
};

/** Which kind of item a create or update call makes, from its method and path. */
export function kindOf(method: string, path: string): string {
  const p = path.replace(/^\/api(\/v1)?/, "").split("?")[0];
  if (method !== "POST") return "update";
  if (/^\/account\/workspaces$/.test(p)) return "workspace";
  if (/\/keys$|\/api-keys$/.test(p)) return "key";
  if (/^\/agents/.test(p)) return "agent";
  if (/invit/.test(p)) return "invite";
  if (/^\/domains$/.test(p)) return "domain";
  if (/^\/projects$/.test(p)) return "project";
  if (/^\/tasks$/.test(p)) return "task";
  if (/^\/chat\/channels$/.test(p)) return "channel";
  if (/\/pin$/.test(p)) return "pin";
  if (/\/messages$/.test(p)) return "message";
  if (/key-?results$/.test(p)) return "keyResult";
  if (/^\/goals$/.test(p)) return "goal";
  if (/^\/docs$/.test(p)) return "doc";
  if (/^\/meetings$/.test(p)) return "meeting";
  if (/^\/templates$/.test(p)) return "template";
  return "other";
}

/** Rows a planned run costs: the calls by kind times their cost. */
export function estimateRows(planned: Record<string, number>): number {
  return Object.entries(planned).reduce((n, [k, c]) => n + c * (ROW_COST[k] ?? ROW_COST.other), 0);
}

interface State { base: string; workspaceId?: string; workspaceKey?: string; agents: Record<string, { id: string; member?: boolean; keyId?: string; secret?: string; address?: string }> }

// ---------------------------------------------------------------- args
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string, d?: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

export async function main() {
  const configPath = opt("config");
  const base = (opt("base") ?? process.env.ORG_BASE_URL ?? "").replace(/\/$/, "");
  if (!configPath || !base) throw new Error("Pass --config <file> and --base <url>.");
  const cfg = JSON.parse(readFileSync(resolve(configPath), "utf8")) as OrgConfig;
  for (const extra of (opt("merge") ?? "").split(",").filter(Boolean)) mergeConfig(cfg, JSON.parse(readFileSync(resolve(extra), "utf8")));
  const statePath = resolve(opt("state") ?? `${homedir()}/.multies-dogfood/${new URL(base).host}-${slug(cfg.workspace.name)}.json`);
  const run = new Runner(base, cfg, statePath, flag("dry-run"), flag("send-invites"));
  run.maxWrites = Number(opt("max-writes", "400"));
  run.skip = new Set((opt("skip") ?? "").split(",").filter(Boolean));
  await run.all();
}

export class Runner {
  cookie = "";
  state: State;
  writes = 0; // create or update calls made
  planned: Record<string, number> = {}; // create or update calls by kind, made or (in a dry run) planned
  maxWrites = 400; // a live run stops before more create or update calls than this (--max-writes)
  skip = new Set<string>(); // whole steps left out (--skip docs,templates)
  fresh = false; // a dry run for a workspace that doesn't exist yet: nothing to read, everything is planned from the config
  log: string[] = [];
  members: { userId: string; email: string; name: string; role: string }[] = [];
  me = "";
  constructor(public base: string, public cfg: OrgConfig, public statePath: string, public dry: boolean, public sendInvites: boolean) {
    this.state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { base, agents: {} };
  }

  save() {
    if (this.dry) return;
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    chmodSync(this.statePath, 0o600);
  }
  note(s: string) { this.log.push(s); console.log(s); }

  // ------------------------------------------------------------ http
  async http(method: string, path: string, body?: unknown, auth: "key" | "session" | "none" = "key", key?: string): Promise<any> {
    const headers: Record<string, string> = { accept: "application/json", origin: this.base };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth === "key") headers.authorization = `Bearer ${key ?? this.state.workspaceKey}`;
    if (auth === "session" && this.cookie) headers.cookie = this.cookie;
    const mutating = method !== "GET";
    if (mutating && !path.startsWith("/api/auth/")) {
      const kind = kindOf(method, path);
      this.planned[kind] = (this.planned[kind] ?? 0) + 1;
      if (this.dry) { this.note(`  dry run: ${method} ${path}`); return { dry: true }; }
      if (this.writes >= this.maxWrites) throw new Error(`Stopped before ${method} ${path}: this run reached --max-writes ${this.maxWrites}. Re-run to continue; finished items are skipped.`);
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
      const set = res.headers.getSetCookie?.() ?? [];
      if (set.length) this.mergeCookies(set);
      if (res.status === 429) { const wait = Number(res.headers.get("retry-after") ?? 2 ** attempt); await sleep(Math.min(60, wait) * 1000); continue; }
      const text = await res.text();
      const data = text ? safeJson(text) : {};
      if (!res.ok) { const e = new Error(`${method} ${path} answered ${res.status}: ${JSON.stringify(data).slice(0, 300)}`) as Error & { status: number; data: unknown }; e.status = res.status; e.data = data; throw e; }
      if (mutating && !path.startsWith("/api/auth/")) this.writes++;
      return data;
    }
    throw new Error(`${method} ${path}: still rate limited after retries`);
  }
  mergeCookies(set: string[]) {
    const jar = new Map(this.cookie.split("; ").filter(Boolean).map((c) => [c.split("=")[0], c] as const));
    for (const s of set) { const pair = s.split(";")[0]; jar.set(pair.split("=")[0], pair); }
    this.cookie = [...jar.values()].join("; ");
  }
  v1 = (m: string, p: string, b?: unknown, key?: string) => this.http(m, `/api/v1${p}`, b, "key", key);
  app = (m: string, p: string, b?: unknown) => this.http(m, p, b, "session");

  // ------------------------------------------------------------ steps
  async all() {
    const t0 = Date.now();
    await this.signIn();
    await this.workspace();
    await this.apiKey();
    if (this.fresh) { this.planFromConfig(); return this.report(t0); }
    await this.loadMembers();
    await this.domain();
    await this.agents();
    await this.invites();
    const projects = this.skip.has("projects") ? {} : await this.projects();
    if (!this.skip.has("channels")) await this.channels();
    if (!this.skip.has("goals")) await this.goals(projects);
    if (!this.skip.has("docs")) await this.docs(projects);
    if (!this.skip.has("meetings")) await this.meetings(projects);
    if (!this.skip.has("templates")) await this.templates();
    this.save();
    await this.report(t0);
  }

  /** Every item in the config as a planned create, for a dry run of a brand new workspace. */
  planFromConfig() {
    const c = this.cfg;
    const add = (kind: string, n: number) => { if (n) this.planned[kind] = (this.planned[kind] ?? 0) + n; };
    add("domain", c.workspace.domain && c.agents?.length ? 1 : 0);
    add("agent", c.agents?.length ?? 0);
    add("invite", this.sendInvites ? c.invites?.length ?? 0 : 0);
    if (!this.skip.has("projects")) { add("project", c.projects?.length ?? 0); add("task", (c.projects ?? []).reduce((n, p) => n + (p.tasks?.length ?? 0), 0)); }
    if (!this.skip.has("channels")) { add("channel", c.channels?.length ?? 0); add("message", (c.channels ?? []).filter((ch) => ch.welcome).length); add("pin", (c.channels ?? []).filter((ch) => ch.welcome).length); }
    if (!this.skip.has("goals")) { add("goal", c.goals?.length ?? 0); add("keyResult", (c.goals ?? []).reduce((n, g) => n + (g.keyResults?.length ?? 0), 0)); }
    if (!this.skip.has("docs")) add("doc", c.docs?.length ?? 0);
    if (!this.skip.has("meetings")) { add("meeting", c.meetings?.length ?? 0); add("task", (c.meetings ?? []).filter((m) => m.prepTask).length); }
    if (!this.skip.has("templates")) add("template", c.templates?.length ?? 0);
    this.note("Dry run for a new workspace: planned from the config.");
  }

  /** The write estimate against the server's own daily write budget (its public /api/health). */
  async report(t0: number) {
    const calls = Object.values(this.planned).reduce((a, b) => a + b, 0);
    const rows = estimateRows(this.planned);
    const kinds = Object.entries(this.planned).map(([k, n]) => `${n} ${k}`).join(", ") || "nothing";
    let budget = "";
    try {
      const h = await (await fetch(`${this.base}/api/health`)).json() as { writes?: { today: number; budget: number } };
      if (h.writes) budget = ` The server has used ${h.writes.today} of ${h.writes.budget} writes today, so this is about ${Math.round((rows / Math.max(1, h.writes.budget - h.writes.today)) * 100)} percent of what is left.`;
    } catch { /* health not reachable */ }
    this.note(`${this.dry ? "Dry run: would make" : `Done in ${Math.round((Date.now() - t0) / 1000)} s with`} ${calls} create or update calls (${kinds}), about ${rows} database rows.${budget} State: ${this.statePath}`);
  }

  session = true;
  async signIn() {
    const { email, name } = this.cfg.founder;
    const password = process.env.ORG_PASSWORD;
    if (process.env.ORG_SESSION_COOKIE) {
      // A session copied from a browser sign in (for example when password sign in is off and sign in goes through the identity provider).
      this.cookie = process.env.ORG_SESSION_COOKIE;
    } else if (!password) {
      if (!process.env.ORG_API_KEY) throw new Error("Set ORG_PASSWORD (or ORG_SESSION_COOKIE, or ORG_API_KEY for a key only run).");
      this.session = false;
      this.note("Key only run: steps that need a session (workspace, invites) are skipped");
      return;
    } else try {
      await this.http("POST", "/api/auth/sign-in/email", { email, password }, "session");
      this.note(`Signed in as ${email}`);
    } catch (e) {
      if ((e as { status?: number }).status !== 401) throw e;
      if (this.dry) throw new Error(`No account for ${email} yet, and a dry run does not sign up.`, { cause: e });
      try { await this.http("POST", "/api/auth/sign-up/email", { email, password, name }, "session"); }
      catch (e2) { throw new Error(`Sign in failed and sign up was refused for ${email} (an account with another password, or password sign in is off). Use ORG_SESSION_COOKIE from a browser sign in. ${(e2 as Error).message}`, { cause: e2 }); }
      this.note(`Signed up ${email}`);
    }
    const me = await this.app("GET", "/api/account/me");
    if (!me?.user?.id) throw new Error("Not signed in: the session was not accepted.");
    this.me = me.user.id;
  }

  async workspace() {
    if (!this.session) return;
    const name = this.cfg.workspace.name;
    const list = await this.app("GET", "/api/account/workspaces");
    const all = list.workspaces as { id: string; name: string; role?: string }[];
    let ws = all.find((w) => w.name === name);
    // DF-12: a new account's only workspace is the empty one sign up made. Name that one instead of
    // creating a second, so the account doesn't keep an empty workspace beside the real one.
    const only = all.length === 1 && all[0].id === list.currentId && all[0].role === "owner" && /'s workspace$/.test(all[0].name) ? all[0] : undefined;
    if (!ws && only && (await this.app("GET", "/api/account/me"))?.organization?.onboarded === false) {
      await this.app("PATCH", "/api/org", { name });
      ws = { id: only.id, name };
      this.note(`Named the sign up workspace ${name}`);
    } else if (!ws) {
      const out = await this.app("POST", "/api/account/workspaces", { name });
      ws = { id: out.id, name };
      this.note(`Created workspace ${name}`);
    } else this.note(`Workspace ${name} exists`);
    if (list.currentId !== ws.id && !this.dry) await this.app("POST", `/api/account/workspaces/${ws.id}/switch`, {});
    if (this.cfg.workspace.timezone && !this.dry) {
      const org = await this.app("GET", "/api/org");
      const tz = org.organization?.timezone ?? org.timezone;
      if (tz !== this.cfg.workspace.timezone) await this.app("PATCH", "/api/org", { timezone: this.cfg.workspace.timezone }).catch((e) => this.note(`  timezone not set: ${(e as Error).message}`));
    }
    if (this.state.workspaceId && this.state.workspaceId !== ws.id) { this.state.workspaceKey = undefined; this.state.agents = {}; }
    this.state.workspaceId = ws.id;
  }

  async apiKey() {
    if (process.env.ORG_API_KEY) { this.state.workspaceKey = process.env.ORG_API_KEY; }
    if (!this.session) { if (!this.state.workspaceKey) throw new Error("No workspace key."); return; }
    if (this.state.workspaceKey) {
      try { await this.v1("GET", "/projects"); this.note("Workspace key works"); return; } catch { this.note("Stored workspace key no longer works, minting a new one"); }
    }
    const out = await this.app("POST", "/api/developer/keys", { name: "Org setup script", scope: "full" });
    if (out?.dry) { this.fresh = true; return; }
    this.state.workspaceKey = out.secret ?? out.key ?? out.apiKey?.secret;
    if (!this.state.workspaceKey) throw new Error("The key answer carried no secret.");
    this.save();
    this.note("Minted workspace key: Org setup script");
  }

  async loadMembers() {
    if (!this.session) return;
    const team = await this.app("GET", "/api/team");
    this.members = (team.members ?? []).map((m: any) => ({ userId: m.userId ?? m.user?.id ?? m.id, email: m.email ?? m.user?.email, name: m.name ?? m.user?.name, role: m.role }));
  }

  async domain() {
    const name = this.cfg.workspace.domain;
    if (!name || !this.cfg.agents?.length) return;
    const list = arr(await this.v1("GET", "/domains"));
    if (list.some((d: any) => d.name === name)) return this.note(`Domain ${name} exists`);
    try { await this.v1("POST", "/domains", { name }); this.note(`Added domain ${name} (verify DNS separately)`); }
    catch (e) { this.note(`  domain ${name} not added: ${(e as Error).message}`); }
  }

  /**
   * AI agents become agent members (round 12 default): a member with a title and bio, its own
   * key, no seat and no mailbox (10 on Free). An agent with inbox: true is made the older way,
   * as a mail agent with an address on the workspace domain.
   */
  async agents() {
    const want = this.cfg.agents ?? [];
    if (!want.length) return;
    const people = arr(await this.v1("GET", "/people")) as any[];
    const mailAgents = want.some((a) => a.inbox) ? arr(await this.v1("GET", "/agents")) as any[] : [];
    for (const a of want) {
      if (a.inbox) { await this.mailAgent(a, mailAgents); continue; }
      const bio = a.bio.slice(0, 500);
      const found = people.find((x) => x.type === "member" && x.kind === "agent" && x.name === a.name);
      if (!found) {
        try {
          const out = await this.v1("POST", "/agent-members", { name: a.name, title: a.title, bio });
          this.state.agents[a.key] = { id: out.member.userId ?? out.member.id, member: true, keyId: out.apiKey?.id, secret: out.secret };
          this.save();
          this.note(`Created agent member ${a.name} (${a.title}) with key "${a.name} key"`);
        } catch (e) { this.note(`  agent ${a.name} not created: ${(e as Error).message}`); }
        continue;
      }
      const id = found.userId ?? found.id;
      if ((found.title ?? "") !== a.title || (found.bio ?? "") !== bio) { await this.v1("PATCH", `/people/${id}`, { title: a.title, bio }); this.note(`  title and bio updated for ${a.name}`); }
      const s = this.state.agents[a.key];
      if (!s?.secret) {
        const k = await this.v1("POST", `/agent-members/${id}/keys`, { name: `${a.name} key` });
        this.state.agents[a.key] = { id, member: true, keyId: k.apiKey?.id ?? k.id, secret: k.secret ?? k.apiKey?.secret };
        this.save();
        this.note(`Agent member ${a.name} exists; minted a fresh key (the old secret was not on file)`);
      } else this.note(`Agent member ${a.name} exists`);
    }
  }

  async mailAgent(a: NonNullable<OrgConfig["agents"]>[number], have: any[]) {
    const bio = `${a.title}. ${a.bio}`.slice(0, 500);
    const found = have.find((x) => x.name === a.name);
    if (!found) {
      try {
        // AIS1: an API key creates agents only at "a person approves every message"; a person lowers it in the app.
        const out = await this.v1("POST", "/agents", { name: a.name, description: bio, localPart: a.localPart ?? slug(a.name), createKey: true });
        this.state.agents[a.key] = { id: out.agent.id, keyId: out.apiKey?.id, secret: out.apiKey?.secret, address: out.agent.address };
        this.save();
        this.note(`Created mail agent ${a.name} (${a.title}) with key "${a.name} agent key"`);
        if (a.approvalMode && a.approvalMode !== "always") this.note(`  ${a.name} starts with a person approving every message; set approval to "${a.approvalMode}" yourself in the app (Agents, ${a.name}, Guardrails)`);
      } catch (e) { this.note(`  agent ${a.name} not created: ${(e as Error).message}`); }
      return;
    }
    if ((found.description ?? "") !== bio) { await this.v1("PATCH", `/agents/${found.id}`, { description: bio }); this.note(`  bio updated for ${a.name}`); }
    const s = this.state.agents[a.key];
    if (!s?.secret) {
      const k = await this.v1("POST", `/agents/${found.id}/keys`, { name: `${a.name} agent key` });
      this.state.agents[a.key] = { id: found.id, keyId: k.id ?? k.apiKey?.id, secret: k.secret ?? k.apiKey?.secret, address: found.address };
      this.save();
      this.note(`Mail agent ${a.name} exists; minted a fresh key (the old secret was not on file)`);
    } else this.note(`Mail agent ${a.name} exists`);
  }

  async invites() {
    for (const inv of this.cfg.invites ?? []) {
      if (this.members.some((m) => m.email?.toLowerCase() === inv.email.toLowerCase())) { this.note(`${inv.email} is already a member`); continue; }
      if (!this.sendInvites) { this.note(`Invite to ${inv.email} (${inv.role}) skipped: pass --send-invites to send real email`); continue; }
      // R25 (DF-7): invites go through the public API with the workspace key, title included.
      const pending = await this.v1("GET", "/invites");
      if ((pending?.invites ?? []).some((i: any) => i.email?.toLowerCase() === inv.email.toLowerCase())) { this.note(`Invite to ${inv.email} already pending`); continue; }
      try {
        await this.v1("POST", "/invites", { email: inv.email, role: inv.role, ...(inv.title ? { title: inv.title } : {}) });
        this.note(`Invited ${inv.email} as ${inv.role}`);
      } catch (e) {
        if (!/already in this workspace/.test((e as Error).message)) throw e;
        this.note(`${inv.email} is already a member`);
      }
    }
  }

  /** "agent:<key>" -> agent:<id>, "member:self" -> member:<me>, "member:<email>" -> member:<userId>. */
  ref(r?: Ref): string | undefined {
    if (!r) return undefined;
    const [kind, v] = [r.slice(0, r.indexOf(":")), r.slice(r.indexOf(":") + 1)];
    if (kind === "agent") { const a = this.state.agents[v]; return a ? `${a.member ? "member" : "agent"}:${a.id}` : undefined; }
    if (v === "self") return this.me ? `member:${this.me}` : undefined;
    const m = this.members.find((x) => x.email?.toLowerCase() === v.toLowerCase());
    return m ? `member:${m.userId}` : undefined;
  }

  async projects(): Promise<Record<string, string>> {
    const ids: Record<string, string> = {};
    const want = [...(this.cfg.projects ?? [])];
    for (const mt of this.cfg.meetings ?? []) if (mt.prepTask && !want.some((p) => p.name === mt.prepTask!.project)) want.push({ name: mt.prepTask.project });
    const have = arr(await this.v1("GET", "/projects")) as any[];
    for (const p of want) {
      let proj = have.find((x) => x.name === p.name);
      if (!proj) {
        const out = await this.v1("POST", "/projects", { name: p.name, description: p.description, key: p.key, color: p.color });
        proj = out.project ?? out;
        this.note(`Created project ${p.name}`);
      }
      ids[p.name] = proj.id;
      const owner = this.ref(p.owner);
      if (owner?.startsWith("member:") && proj.ownerId !== owner.slice(7)) { await this.v1("PATCH", `/projects/${proj.id}`, { ownerId: owner.slice(7) }); this.note(`  owner set on ${p.name}`); }
      if (!p.tasks?.length) continue;
      if (this.dry && !proj.id) {
        // A project this dry run would create: every task in it would be created too.
        this.planned.task = (this.planned.task ?? 0) + p.tasks.length;
        this.note(`  dry run: ${p.tasks.length} tasks in ${p.name}`);
        continue;
      }
      const tasks = (await this.v1("GET", `/projects/${proj.id}`).then((d) => d.tasks).catch(() => null)) ?? arr(await this.v1("GET", `/tasks?projectId=${encodeURIComponent(proj.id)}&includeSubtasks=true`));
      const titles = new Set((tasks as any[]).map((t) => t.title));
      for (const t of p.tasks) {
        if (titles.has(t.title)) continue;
        await this.v1("POST", "/tasks", { title: t.title, notes: t.notes, projectId: proj.id, priority: t.priority, due: t.due, assignee: this.ref(t.assignee) ?? null, labels: t.labels, status: t.status });
        this.note(`  task: ${t.title}`);
      }
    }
    return ids;
  }

  async channels() {
    const have = arr(await this.v1("GET", "/chat/channels")) as any[];
    for (const ch of this.cfg.channels ?? []) {
      let c = have.find((x) => x.name === ch.name);
      if (!c) {
        const out = await this.v1("POST", "/chat/channels", { name: ch.name, topic: ch.purpose });
        c = out.channel ?? out;
        this.note(`Created #${ch.name}`);
      }
      if (c.id && (c.topic ?? "") !== ch.purpose) { await this.v1("PATCH", `/chat/channels/${c.id}`, { topic: ch.purpose }); this.note(`  purpose set on #${ch.name}`); }
      if (!ch.welcome || !c.id) continue;
      const msgs = arr(await this.v1("GET", `/chat/channels/${c.id}/messages?limit=50`)) as any[];
      let welcome = msgs.find((m) => (m.body ?? "").startsWith(ch.welcome!.slice(0, 40)));
      if (!welcome) {
        const by = ch.welcomeBy?.startsWith("agent:") ? this.state.agents[ch.welcomeBy.slice(6)]?.secret : undefined;
        const out = await this.v1("POST", `/chat/channels/${c.id}/messages`, { body: ch.welcome }, by);
        welcome = out?.message ?? out;
        this.note(`  welcome posted in #${ch.name}`);
      }
      // One write; a server older than round 12 has no pins, which is not worth failing the run for.
      if (welcome?.id && !welcome.pinnedAt) {
        try { await this.v1("POST", `/chat/messages/${welcome.id}/pin`); this.note(`  welcome pinned in #${ch.name}`); }
        catch (e) { this.note(`  could not pin the welcome in #${ch.name}: ${(e as Error).message}`); }
      }
    }
  }

  async goals(projects: Record<string, string>) {
    const have = arr(await this.v1("GET", "/goals")) as any[];
    const flat = (gs: any[]): any[] => gs.flatMap((g) => [g, ...flat(g.children ?? [])]);
    for (const g of this.cfg.goals ?? []) {
      if (flat(have).some((x) => x.name === g.name)) { this.note(`Goal ${g.name} exists`); continue; }
      await this.v1("POST", "/goals", {
        name: g.name, description: g.description, due: g.due, ownerId: this.me,
        keyResults: (g.keyResults ?? []).map((k) => ({ name: k.name, kind: k.kind ?? "number", start: k.start, target: k.target, current: k.current, unit: k.unit, projectId: k.project ? projects[k.project] : undefined })),
      });
      this.note(`Created goal ${g.name}`);
    }
  }

  async docs(projects: Record<string, string>) {
    // GET /api/v1/docs answers the API reference page instead of the list (finding F1), so the
    // list falls back to the app route when the public one does not answer JSON.
    const pub = await this.v1("GET", "/docs");
    if (pub?.raw !== undefined && !this.session) return this.note("Docs skipped: the public docs list does not answer JSON (F1) and there is no session");
    const have = (pub?.raw !== undefined ? arr(await this.app("GET", "/api/docs")) : arr(pub)) as any[];
    for (const d of this.cfg.docs ?? []) {
      if (have.some((x) => x.title === d.title)) { this.note(`Doc ${d.title} exists`); continue; }
      await this.v1("POST", "/docs", { title: d.title, text: d.text, projectId: d.project ? projects[d.project] : undefined });
      this.note(`Created doc ${d.title}`);
    }
  }

  async meetings(projects: Record<string, string>) {
    const have = arr(await this.v1("GET", "/meetings?upcoming=true")) as any[];
    for (const m of this.cfg.meetings ?? []) {
      const when = nextWeekday(m.weekday, m.time, m.timezone);
      if (have.some((x) => x.title === m.title && x.status !== "cancelled")) this.note(`Next ${m.title} is already on the calendar`);
      else {
        await this.v1("POST", "/meetings", { title: m.title, startsAt: when.toISOString(), durationMin: m.durationMin ?? 30, invitees: m.invitees ?? [], sendInvites: false });
        this.note(`Scheduled ${m.title} for ${when.toISOString()} (meetings do not repeat yet, so a weekly prep task carries the rhythm)`);
      }
      if (m.prepTask) {
        const pid = projects[m.prepTask.project];
        const title = `Prepare: ${m.title}`;
        const tasks = arr(await this.v1("GET", `/tasks?projectId=${encodeURIComponent(pid)}`)) as any[];
        if (!tasks.some((t) => t.title === title)) {
          const day = new Intl.DateTimeFormat("en-CA", { timeZone: m.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(when);
          await this.v1("POST", "/tasks", { title, projectId: pid, due: day, assignee: this.ref(m.prepTask.assignee) ?? null, repeat: { freq: "weekly", interval: 1, weekdays: [m.weekday] }, notes: `Agenda and notes for ${m.title}, ${m.time} ${m.timezone}.` });
          this.note(`  weekly prep task: ${title}`);
        }
      }
    }
  }

  async templates() {
    // Written from scratch through the public API (round 12): no source task in a project, one write each.
    const have = arr(await this.v1("GET", "/templates")) as any[];
    for (const t of this.cfg.templates ?? []) {
      if (have.some((x) => x.name === t.name)) { this.note(`Template ${t.name} exists`); continue; }
      const kind = t.kind ?? "task";
      const data = kind === "doc" ? { title: t.title, text: t.notes ?? "" } : { title: t.title, notes: t.notes };
      await this.v1("POST", "/templates", { kind, data, name: t.name, description: t.description, category: t.category ?? "Custom" });
      this.note(`Created template ${t.name}`);
    }
  }
}

// ---------------------------------------------------------------- helpers
export function mergeConfig(into: OrgConfig, extra: Partial<OrgConfig>) {
  for (const [k, v] of Object.entries(extra) as [keyof OrgConfig, unknown][]) {
    if (!Array.isArray(v)) continue;
    if (k === "projects") {
      for (const p of v as NonNullable<OrgConfig["projects"]>) {
        const same = (into.projects ??= []).find((x) => x.name === p.name);
        if (same) same.tasks = [...(same.tasks ?? []), ...(p.tasks ?? [])]; else into.projects.push(p);
      }
    } else (into as unknown as Record<string, unknown[]>)[k] = [...(((into as unknown as Record<string, unknown[]>)[k]) ?? []), ...v];
  }
}

export function slug(s: string) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40); }
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function safeJson(t: string) { try { return JSON.parse(t); } catch { return { raw: t.slice(0, 200) }; } }
/** The first array in an answer: list routes answer { data }, { tasks }, { channels } and so on. */
export function arr(d: any): any[] { if (Array.isArray(d)) return d; for (const v of Object.values(d ?? {})) if (Array.isArray(v)) return v; return []; }

/** The next given weekday (0 Sunday) at HH:MM wall time in an IANA zone, as a UTC Date. */
export function nextWeekday(weekday: number, hhmm: string, tz: string, from = new Date()): Date {
  const [h, m] = hhmm.split(":").map(Number);
  for (let i = 0; i < 8; i++) {
    const day = new Date(from.getTime() + i * 86_400_000);
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(day).map((p) => [p.type, p.value]));
    const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
    if (wd !== weekday) continue;
    const guess = Date.UTC(+parts.year, +parts.month - 1, +parts.day, h, m);
    const off = tzOffsetMs(tz, new Date(guess));
    const at = new Date(guess - off);
    if (at > from) return at;
  }
  throw new Error("no weekday found");
}
function tzOffsetMs(tz: string, d: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - d.getTime();
}

if (process.argv[1]?.endsWith("org-setup.ts")) main().catch((e) => { console.error((e as Error).message); process.exit(1); });
