import { SITE_URL } from "@/web/components/seo-meta";
import { IconAgent, IconArrowRight, IconCheck, IconClipboardCheck, IconFileCode, IconKey, IconRadio, IconShieldCheck } from "@/web/components/ui/icon";
import { useState } from "react";
import { ButtonLink } from "@/web/components/ui/button";
import { CopyButton } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";

// R76: a fixed origin, not window.location, so the prerendered HTML and the client render match (no hydration redo).
const BASE = SITE_URL;

function Code({ code, label }: { code: string; label: string }) {
  return (
    <figure className="overflow-hidden rounded-xl border border-line bg-surface">
      <figcaption className="flex items-center justify-between border-b border-line px-4 py-2 text-xs text-subtle"><span>{label}</span><CopyButton value={code} /></figcaption>
      <pre tabIndex={0} className="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed text-fg/90">{code}</pre>
    </figure>
  );
}

const STEPS = [
  {
    title: "Create the inbox",
    body: "Use a workspace key from Settings, Developers. One call makes the agent, its address on your domain and an agent key, shown once.",
    code: `curl ${BASE}/api/v1/agents \\
  -H "Authorization: Bearer $MULTIES_WORKSPACE_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"name": "Signup bot", "localPart": "signups"}'`,
  },
  {
    title: "Read mail as JSON",
    body: "Each message comes with its new text (quoted history removed), one-time codes and links pulled out, attachment URLs, and who wrote it.",
    code: `curl ${BASE}/api/v1/agents/$AGENT_ID/threads \\
  -H "Authorization: Bearer $MULTIES_AGENT_KEY"

curl ${BASE}/api/v1/threads/$THREAD_ID \\
  -H "Authorization: Bearer $MULTIES_AGENT_KEY"
# { "messages": [{ "latestText": "Your code is 482913.", "codes": ["482913"], ... }] }`,
  },
  {
    title: "Reply in the thread",
    body: "Replies thread properly with a Re: subject. With approval on (the default), the answer is pending_approval and a person decides in the app.",
    code: `curl ${BASE}/api/v1/agents/$AGENT_ID/threads/$THREAD_ID/reply \\
  -H "Authorization: Bearer $MULTIES_AGENT_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"text": "Thanks, that works. See you Thursday."}'
# 202 { "status": "pending_approval", "approval": { "id": "apr_..." } }`,
  },
];

// R36: generic client labels (no vendor names in product copy). Every snippet uses the open MCP config
// shapes; a snippet that needed one vendor's own command or SDK was dropped (see the R36 report).
const MCP: Record<string, { label: string; code: string; note: string }> = {
  desktop: {
    label: "Desktop app", note: "In your chat app's settings, add a custom connector (it may be called an integration or MCP server). Paste the URL, then sign in to Multies and pick a workspace. No key needed.",
    code: `${BASE}/api/v1/mcp`,
  },
  cli: {
    label: "Command line agent", note: "Most command line agents read an mcp.json file in your home folder or project. They open the Multies sign in page the first time. To use an agent key instead, add the headers line.",
    code: `{
  "mcpServers": {
    "multies": {
      "type": "http",
      "url": "${BASE}/api/v1/mcp",
      "headers": { "Authorization": "Bearer mm_live_YOUR_AGENT_KEY" }
    }
  }
}`,
  },
  editor: {
    label: "Code editor", note: "Add Multies to your editor's MCP settings (often mcp.json in the project or your user settings). The editor opens the Multies sign in page, or you can add an Authorization header with an agent key.",
    code: `{
  "mcpServers": {
    "multies": { "url": "${BASE}/api/v1/mcp" }
  }
}`,
  },
  any: {
    label: "Any MCP client", note: "Build your own agent with the open MCP SDK. Streamable HTTP, with an agent key, a workspace key or an OAuth token.",
    code: `import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("${BASE}/api/v1/mcp"), {
  requestInit: { headers: { Authorization: "Bearer mm_live_YOUR_AGENT_KEY" } },
}));
const { tools } = await client.listTools();
const inbox = await client.callTool({ name: "list_threads", arguments: { unread: true } });`,
  },
};

const TOOLS = [
  ["list_inboxes", "The agent's inbox and shared mailboxes, with today's sends and its approval rule"],
  ["list_threads", "Recent threads with sender, snippet and unread count"],
  ["read_thread", "Every message as clean text, with codes, links and attachments"],
  ["search", "Subject, sender, recipients and body"],
  ["send_email", "A new message, inside the agent's guardrails"],
  ["reply", "A threaded reply"],
  ["wait_for_email", "Waits up to 50 seconds for new mail, such as a sign up code"],
  ["create_agent_inbox", "A new agent inbox (workspace keys only)"],
];

const GUARDRAILS = [
  { icon: IconClipboardCheck, title: "Approval queue", body: "Every send waits for a person by default. Approve, edit then approve, or reject with a note the agent receives." },
  { icon: IconShieldCheck, title: "Caps and allow lists", body: "A daily send cap per agent, plus addresses or whole domains it may write to." },
  { icon: IconKey, title: "Scoped keys", body: "An agent key only reaches that agent's inbox and the shared mailboxes you give it. Workspace keys get scopes per area, like mail:read or tasks:write, so a script can do its one job and nothing else." },
  { icon: IconFileCode, title: "Audit log", body: "Every read, send, approval and rejection, with the agent's name, and whether it came through the API or MCP." },
];

export function AgentsDevPage() {
  const [tab, setTab] = useState<keyof typeof MCP>("desktop");
  return (
    <>
      <section className="pt-32 sm:pt-40">
        <div className="mx-auto max-w-4xl px-5 text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1 text-xs text-muted"><IconAgent className="h-3.5 w-3.5" aria-hidden />Agent inboxes</span>
          <h1 className="mt-5 text-4xl font-semibold leading-[1.08] tracking-[-0.03em] sm:text-6xl">Give your AI agent a real inbox.</h1>
          <p className="mx-auto mt-6 max-w-2xl text-[17px] leading-relaxed text-muted">
            An address on your own domain, mail as JSON by webhook, stream or MCP, and replies that wait for a person until you trust them. Three agent inboxes are free.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <ButtonLink to="/signup" size="lg">Start free <IconArrowRight className="h-4 w-4" /></ButtonLink>
            <a href="/api/v1/reference" className="inline-flex h-11 items-center justify-center rounded-lg border border-line px-5 text-[15px] font-medium hover:bg-hover">API reference</a>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-5 py-20" aria-labelledby="quickstart">
        <h2 id="quickstart" className="text-2xl font-semibold tracking-tight sm:text-3xl">Quickstart</h2>
        <ol className="mt-8 space-y-10">
          {STEPS.map((s, i) => (
            <li key={s.title} className="grid gap-5 md:grid-cols-[1fr_1.6fr]">
              <div>
                <span className="font-mono text-sm text-subtle" aria-hidden>{i + 1}.</span>
                <h3 className="mt-1 text-[17px] font-semibold">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{s.body}</p>
              </div>
              <Code code={s.code} label="Terminal" />
            </li>
          ))}
        </ol>
      </section>

      <section className="border-y border-line bg-surface/40" aria-labelledby="realtime">
        <div className="mx-auto grid max-w-5xl gap-8 px-5 py-20 md:grid-cols-2">
          <div>
            <h2 id="realtime" className="flex items-center gap-2 text-2xl font-semibold tracking-tight"><IconRadio className="h-5 w-5 text-brand-hover" aria-hidden />New mail, as it lands</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted">Pick what suits your agent. Webhooks are signed with the Standard Webhooks spec. The stream is Server-Sent Events: reconnect with Last-Event-ID and nothing is missed. Or poll the event feed with the last id you saw.</p>
            <ul className="mt-5 space-y-2 text-sm">
              {["message.received, with the parsed message", "approval.requested and approval.decided", "message.sent"].map((x) => <li key={x} className="flex gap-2"><IconCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden />{x}</li>)}
            </ul>
          </div>
          <Code label="Stream" code={`curl -N ${BASE}/api/v1/agents/$AGENT_ID/events/stream \\
  -H "Authorization: Bearer $MULTIES_AGENT_KEY"

event: message.received
id: 41
data: {"type":"message.received","data":{"subject":"Your code",
  "latestText":"Your code is 482913.","codes":["482913"]}}`} />
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-5 py-20" aria-labelledby="mcp">
        <h2 id="mcp" className="text-2xl font-semibold tracking-tight sm:text-3xl">Connect with MCP</h2>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">Multies' MCP server runs at <code className="font-mono text-fg">{BASE}/api/v1/mcp</code> (Streamable HTTP). Add it by URL and sign in, and the client works as you; or use an agent key and it acts as that agent, inside its guardrails.</p>
        <div className="mt-6 flex flex-wrap gap-1 rounded-lg bg-fill p-0.5 text-sm sm:w-fit" role="tablist" aria-label="MCP clients">
          {Object.entries(MCP).map(([id, m]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id as keyof typeof MCP)}
              className={cn("rounded-md px-3 py-1.5", tab === id ? "bg-surface font-medium text-fg shadow-card" : "text-muted hover:text-fg")}>{m.label}</button>
          ))}
        </div>
        <p className="mt-4 text-sm text-muted">{MCP[tab].note}</p>
        <div className="mt-3"><Code code={MCP[tab].code} label={MCP[tab].label} /></div>
        <div className="mt-10 overflow-hidden rounded-xl border border-line">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">MCP tools</caption>
            <thead className="bg-surface text-xs text-subtle"><tr><th scope="col" className="px-4 py-2.5 font-medium">Tool</th><th scope="col" className="px-4 py-2.5 font-medium">What it does</th></tr></thead>
            <tbody className="divide-y divide-line">
              {TOOLS.map(([n, d]) => <tr key={n}><td className="px-4 py-2.5 font-mono text-[13px]">{n}</td><td className="px-4 py-2.5 text-muted">{d}</td></tr>)}
            </tbody>
          </table>
        </div>
        <a href="/developers/mcp" className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-brand-hover hover:underline">See every tool, with scopes and examples <IconArrowRight className="h-4 w-4" aria-hidden /></a>
      </section>

      <section className="border-t border-line" aria-labelledby="guardrails">
        <div className="mx-auto max-w-5xl px-5 py-20">
          <h2 id="guardrails" className="text-2xl font-semibold tracking-tight sm:text-3xl">You stay in charge</h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-2">
            {GUARDRAILS.map(({ icon: Icon, title, body }) => (
              <div key={title} className="rounded-xl border border-line bg-surface p-5">
                <Icon className="h-5 w-5 text-brand-hover" aria-hidden />
                <h3 className="mt-3 font-semibold">{title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">{body}</p>
              </div>
            ))}
          </div>
          <p className="mt-10 text-sm text-muted">Free: 3 agent inboxes and 3,000 agent messages a month. Each extra agent inbox is A$1 a month and adds 1,000 messages. <a className="text-brand-hover underline underline-offset-2" href="/pricing">See pricing</a>.</p>
        </div>
      </section>
    </>
  );
}
