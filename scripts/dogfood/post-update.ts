/* eslint-disable @typescript-eslint/no-explicit-any -- untyped JSON answers from the API; the OpenAPI document is the contract */
/**
 * Posts an update (a release note, by default) to a channel as one of the workspace's AI agents,
 * and moves the tasks it closes to done. Run it after every production deploy:
 *
 *   npx tsx scripts/dogfood/post-update.ts --base https://multies.si --state <state.json> \
 *     --release cb021009d363 --notes-file /tmp/notes.md [--tasks "Title one|tsk_abc123"] [--label release:cb021009d363]
 *
 * Options:
 *   --channel releases   the channel to post in (default releases)
 *   --agent builder      which agent posts, by its key in the org config (default builder)
 *   --release <id>       the release id; the post starts "Release <id>"; a second run with the same id posts nothing
 *   --notes "<text>"     or --notes-file <path>: the body (plain text, one item per line)
 *   --tasks "<a|b>"      tasks to close, by exact title, ref (PRD-1) or task id, separated by |
 *   --label <label>      also close every open task carrying this label
 *   --dry-run            print what would happen
 *
 * The agent's key comes from the state file written by org-setup.ts, or from ORG_AGENT_KEY.
 * Only the public REST API (/api/v1) is used. About 1 + (tasks closed) writes per run.
 */
import { existsSync, readFileSync } from "node:fs";
import { arr } from "./org-setup";

const args = process.argv.slice(2);
const opt = (n: string, d?: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const dry = args.includes("--dry-run");

async function main() {
  const base = (opt("base") ?? process.env.ORG_BASE_URL ?? "").replace(/\/$/, "");
  const statePath = opt("state");
  const agentName = opt("agent", "builder")!;
  const state = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { agents: {} };
  const key = process.env.ORG_AGENT_KEY ?? state.agents?.[agentName]?.secret;
  const release = opt("release");
  const notes = opt("notes") ?? (opt("notes-file") ? readFileSync(opt("notes-file")!, "utf8") : "");
  if (!base || !key || !release) throw new Error("Pass --base, --release and --state (or ORG_AGENT_KEY).");

  const api = async (method: string, path: string, body?: unknown) => {
    if (dry && method !== "GET") { console.log(`dry run: ${method} ${path}`); return {}; }
    const res = await fetch(`${base}/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  };

  const channelName = opt("channel", "releases")!;
  const channel = (arr(await api("GET", "/chat/channels")) as any[]).find((c) => c.name === channelName);
  if (!channel) throw new Error(`No #${channelName} channel. Run org-setup.ts first.`);

  // Close tasks first, so the note can link them.
  const wanted = (opt("tasks") ?? "").split("|").map((s) => s.trim()).filter(Boolean);
  const label = opt("label");
  const closed: { id: string; title: string }[] = [];
  if (wanted.length || label) {
    const open = arr(await api("GET", "/tasks?includeSubtasks=true")) as any[];
    for (const t of open) {
      const hit = wanted.includes(t.id) || wanted.includes(t.ref) || wanted.includes(t.title) || (label && (t.labels ?? []).includes(label));
      const done = t.status?.category === "done" || t.category === "done" || t.status === "done";
      if (!hit || done) continue;
      await api("PATCH", `/tasks/${t.id}`, { status: "done" });
      closed.push({ id: t.id, title: t.title });
      console.log(`Done: ${t.title}`);
    }
    const missing = wanted.filter((w) => !open.some((t) => t.id === w || t.ref === w || t.title === w));
    if (missing.length) console.log(`Not found: ${missing.join(", ")}`);
  }

  const head = `Release ${release}`;
  const recent = arr(await api("GET", `/chat/channels/${channel.id}/messages?limit=50`)) as any[];
  if (recent.some((m) => (m.body ?? "").startsWith(head))) { console.log(`${head} is already posted in #${channelName}`); return; }
  const body = [head, notes.trim(), closed.length ? `Closed:\n${closed.map((t) => `- <#task:${t.id}>`).join("\n")}` : ""].filter(Boolean).join("\n\n");
  await api("POST", `/chat/channels/${channel.id}/messages`, { body });
  console.log(`Posted ${head} in #${channelName} as ${agentName}, ${closed.length} task(s) closed`);
}

main().catch((e) => { console.error((e as Error).message); process.exit(1); });
