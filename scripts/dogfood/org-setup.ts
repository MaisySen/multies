/* eslint-disable @typescript-eslint/no-explicit-any -- untyped JSON answers from the API; the OpenAPI document is the contract */
/**
 * Org setup for dogfooding: builds a whole company inside a Multies workspace from one
 * config file, so the team that builds the product runs on it for real.
 *
 * Idempotent: every item is found by name first and only created when missing, so a re-run
 * costs a handful of reads and no writes. It talks to the public REST API (/api/v1) with a
 * workspace API key. A few steps have no public route yet and use the app API with a
 * session (sign in, create the workspace, mint the first key, invites, templates); each of
 * those is a dogfood finding in docs/dogfood.md.
 *
 * Usage:
 *   ORG_PASSWORD=... npx tsx scripts/dogfood/org-setup.ts --config scripts/dogfood/org.example.json \
 *     --base http://localhost:8796 [--state /path/state.json] [--dry-run] [--send-invites]
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
  agents?: { key: string; name: string; title: string; bio: string; localPart?: string; approvalMode?: "always" | "external" | "never" }[];
  channels?: { name: string; purpose: string; welcome?: string; welcomeBy?: Ref }[];
  projects?: {
    name: string; key?: string; color?: string; description?: string; owner?: Ref;
    tasks?: { title: string; notes?: string; priority?: "none" | "low" | "medium" | "high" | "urgent"; due?: string; assignee?: Ref; labels?: string[]; status?: "todo" | "doing" | "done" }[];
  }[];
  goals?: { name: string; description?: string; due?: string; keyResults?: { name: string; kind?: "number" | "currency" | "percent" | "tasks"; start?: number; target?: number; current?: number; unit?: string; project?: string }[] }[];
  docs?: { title: string; text: string; project?: string }[];
  meetings?: { title: string; weekday: number; time: string; timezone: string; durationMin?: number; invitees?: string[]; prepTask?: { project: string; assignee?: Ref } }[];
  templates?: { name: string; description?: string; category?: string; project: string; title: string; notes: string }[];
}

interface State { base: string; workspaceId?: string; workspaceKey?: string; agents: Record<string, { id: string; keyId?: string; secret?: string; address?: string }> }

// ---------------------------------------------------------------- args
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string, d?: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

export async function main() {
  const configPath = opt("config");
  const base = (opt("base") ?? process.env.ORG_BASE_URL ?? "").replace(/\/$/, "");
  if (!configPath || !base) throw new Error("Pass --config <file> and --base <url>.");
  const cfg = JSON.parse(readFileSync(resolve(configPath), "utf8")) as OrgConfig;
  const statePath = resolve(opt("state") ?? `${homedir()}/.multies-dogfood/${new URL(base).host}-${slug(cfg.workspace.name)}.json`);
  const run = new Runner(base, cfg, statePath, flag("dry-run"), flag("send-invites"));
  await run.all();
}

class Runner {
  cookie = "";
  state: State;
  writes = 0; // create or update calls, a rough proxy for the rows a run costs
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
    if (mutating && this.dry && !path.startsWith("/api/auth/")) { this.note(`  dry run: ${method} ${path}`); return { dry: true }; }
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
    await this.loadMembers();
    await this.domain();
    await this.agents();
    await this.invites();
    const projects = await this.projects();
    await this.channels();
    await this.goals(projects);
    await this.docs(projects);
    await this.meetings(projects);
    await this.templates(projects);
    this.save();
    this.note(`Done in ${Math.round((Date.now() - t0) / 1000)} s with ${this.writes} create or update calls. State: ${this.statePath}`);
  }

  async signIn() {
    const { email, name } = this.cfg.founder;
    const password = process.env.ORG_PASSWORD;
    if (!password) throw new Error("Set ORG_PASSWORD for the founder account.");
    try {
      await this.http("POST", "/api/auth/sign-in/email", { email, password }, "session");
      this.note(`Signed in as ${email}`);
    } catch (e) {
      if ((e as { status?: number }).status !== 401) throw e;
      if (this.dry) throw new Error(`No account for ${email} yet, and a dry run does not sign up.`, { cause: e });
      await this.http("POST", "/api/auth/sign-up/email", { email, password, name }, "session");
      this.note(`Signed up ${email}`);
    }
    const me = await this.app("GET", "/api/account/me");
    this.me = me.user.id;
  }

  async workspace() {
    const name = this.cfg.workspace.name;
    const list = await this.app("GET", "/api/account/workspaces");
    let ws = (list.workspaces as { id: string; name: string }[]).find((w) => w.name === name);
    if (!ws) {
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
    if (this.state.workspaceKey) {
      try { await this.v1("GET", "/projects"); this.note("Workspace key works"); return; } catch { this.note("Stored workspace key no longer works, minting a new one"); }
    }
    const out = await this.app("POST", "/api/developer/keys", { name: "Org setup script", scope: "full" });
    this.state.workspaceKey = out.secret ?? out.key ?? out.apiKey?.secret;
    if (!this.state.workspaceKey) throw new Error("The key answer carried no secret.");
    this.save();
    this.note("Minted workspace key: Org setup script");
  }

  async loadMembers() {
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

  async agents() {
    const want = this.cfg.agents ?? [];
    if (!want.length) return;
    const have = arr(await this.v1("GET", "/agents")) as any[];
    for (const a of want) {
      const bio = `${a.title}. ${a.bio}`.slice(0, 500);
      let found = have.find((x) => x.name === a.name);
      if (!found) {
        try {
          const out = await this.v1("POST", "/agents", { name: a.name, description: bio, localPart: a.localPart ?? slug(a.name), approvalMode: a.approvalMode ?? "always", createKey: true });
          found = out.agent;
          this.state.agents[a.key] = { id: out.agent.id, keyId: out.apiKey?.id, secret: out.apiKey?.secret, address: out.agent.address };
          this.save();
          this.note(`Created agent ${a.name} (${a.title}) with key "${a.name} agent key"`);
        } catch (e) { this.note(`  agent ${a.name} not created: ${(e as Error).message}`); continue; }
      } else {
        if ((found.description ?? "") !== bio) { await this.v1("PATCH", `/agents/${found.id}`, { description: bio }); this.note(`  bio updated for ${a.name}`); }
        const s = this.state.agents[a.key];
        if (!s?.secret) {
          const k = await this.v1("POST", `/agents/${found.id}/keys`, { name: `${a.name} agent key` });
          this.state.agents[a.key] = { id: found.id, keyId: k.id ?? k.apiKey?.id, secret: k.secret ?? k.apiKey?.secret, address: found.address };
          this.save();
          this.note(`Agent ${a.name} exists; minted a fresh key (the old secret was not on file)`);
        } else this.note(`Agent ${a.name} exists`);
      }
    }
  }

  async invites() {
    for (const inv of this.cfg.invites ?? []) {
      if (this.members.some((m) => m.email?.toLowerCase() === inv.email.toLowerCase())) { this.note(`${inv.email} is already a member`); continue; }
      if (!this.sendInvites) { this.note(`Invite to ${inv.email} (${inv.role}) skipped: pass --send-invites to send real email`); continue; }
      const team = await this.app("GET", "/api/team");
      if ((team.invites ?? []).some((i: any) => i.email?.toLowerCase() === inv.email.toLowerCase())) { this.note(`Invite to ${inv.email} already pending`); continue; }
      await this.app("POST", "/api/team/invites", { email: inv.email, role: inv.role });
      this.note(`Invited ${inv.email} as ${inv.role}`);
    }
  }

  /** "agent:<key>" -> agent:<id>, "member:self" -> member:<me>, "member:<email>" -> member:<userId>. */
  ref(r?: Ref): string | undefined {
    if (!r) return undefined;
    const [kind, v] = [r.slice(0, r.indexOf(":")), r.slice(r.indexOf(":") + 1)];
    if (kind === "agent") { const a = this.state.agents[v]; return a ? `agent:${a.id}` : undefined; }
    if (v === "self") return `member:${this.me}`;
    const m = this.members.find((x) => x.email?.toLowerCase() === v.toLowerCase());
    return m ? `member:${m.userId}` : undefined;
  }

  async projects(): Promise<Record<string, string>> {
    const ids: Record<string, string> = {};
    const want = [...(this.cfg.projects ?? [])];
    for (const t of this.cfg.templates ?? []) if (!want.some((p) => p.name === t.project)) want.push({ name: t.project, description: "Source tasks for the workspace's task templates." });
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
      if (!p.tasks?.length || this.dry && !proj.id) continue;
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
      // No public route updates a channel (finding), so the purpose of an existing channel is set through the app API.
      if (c.id && (c.topic ?? "") !== ch.purpose) { await this.app("PATCH", `/api/chat/channels/${c.id}`, { topic: ch.purpose }); this.note(`  purpose set on #${ch.name}`); }
      if (!ch.welcome || !c.id) continue;
      const msgs = arr(await this.v1("GET", `/chat/channels/${c.id}/messages?limit=50`)) as any[];
      if (msgs.some((m) => (m.body ?? "").startsWith(ch.welcome!.slice(0, 40)))) continue;
      const by = ch.welcomeBy?.startsWith("agent:") ? this.state.agents[ch.welcomeBy.slice(6)]?.secret : undefined;
      await this.v1("POST", `/chat/channels/${c.id}/messages`, { body: ch.welcome }, by);
      this.note(`  welcome posted in #${ch.name}`);
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
          const day = when.toISOString().slice(0, 10);
          await this.v1("POST", "/tasks", { title, projectId: pid, due: day, assignee: this.ref(m.prepTask.assignee) ?? null, repeat: { freq: "weekly", interval: 1, weekdays: [m.weekday] }, notes: `Agenda and notes for ${m.title}, ${m.time} ${m.timezone}.` });
          this.note(`  weekly prep task: ${title}`);
        }
      }
    }
  }

  async templates(projects: Record<string, string>) {
    const list = await this.app("GET", "/api/templates");
    const have = (list.templates ?? []) as any[];
    for (const t of this.cfg.templates ?? []) {
      if (have.some((x) => x.name === t.name)) { this.note(`Template ${t.name} exists`); continue; }
      const pid = projects[t.project];
      const tasks = arr(await this.v1("GET", `/tasks?projectId=${encodeURIComponent(pid)}`)) as any[];
      let src = tasks.find((x) => x.title === t.title);
      if (!src) src = (await this.v1("POST", "/tasks", { title: t.title, notes: t.notes, projectId: pid })).task;
      if (!src?.id) continue;
      await this.app("POST", "/api/templates", { kind: "task", fromTaskId: src.id, name: t.name, description: t.description, category: t.category ?? "Custom" });
      this.note(`Created template ${t.name}`);
    }
  }
}

// ---------------------------------------------------------------- helpers
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
