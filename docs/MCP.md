# MyMail MCP server

MyMail runs a Model Context Protocol server, so Claude, ChatGPT (through the OpenAI API), Cursor
and any MCP client can work an inbox directly.

Bring your own AI: connect Claude, ChatGPT or any agent through MCP, free. MyMail never pays for
or resells AI model calls. People who want the assistant inside webmail add their own OpenAI,
Anthropic, OpenRouter or Groq key in Settings, General, AI; it is encrypted at rest.

- URL: `https://mymail.mymail-app.workers.dev/api/v1/mcp` (your own deployment: `<origin>/api/v1/mcp`)
- Transport: Streamable HTTP, stateless. Built on the official MCP TypeScript SDK.
- Auth: `Authorization: Bearer <key>`.
  - An **agent key** (made with an agent inbox) acts only as that agent: its inbox, the shared
    mailboxes it was given, and sends within its daily cap and approval rule.
  - A **workspace key** sees every agent and mailbox and can create agent inboxes. Sends still go
    out as an agent (pass `agentId`), so guardrails always apply.
  - A **read only** workspace key can call the read tools only.

## Tools

| Tool | What it does |
| --- | --- |
| `list_inboxes` | Agent inboxes (approval rule, sends today) and, for workspace keys, the team's mailboxes |
| `list_threads` | Recent threads with sender, snippet, unread count and which agents took part |
| `read_thread` | Every message: new text without quoted history, one-time codes, links, attachments, who wrote it, and replies waiting for approval |
| `search` | Search subject, sender, recipients and body |
| `send_email` | Send as an agent. Returns `sent` or `pending_approval` |
| `reply` | Reply in a thread as an agent, threaded, with a `Re:` subject |
| `wait_for_email` | Wait up to 50 seconds for new mail, for example a sign up code, and return it parsed |
| `create_agent_inbox` | Workspace keys only: a new agent with its own address and key |

Every read and send an agent makes is in the audit log, marked as coming through MCP.

## Claude Code

```sh
claude mcp add --transport http mymail https://mymail.mymail-app.workers.dev/api/v1/mcp \
  --header "Authorization: Bearer mm_live_YOUR_AGENT_KEY"
```

## Claude Desktop

Claude Desktop's custom connectors sign in with OAuth, which MyMail doesn't offer yet, so connect
through the `mcp-remote` bridge. In Settings, Developer, Edit Config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mymail": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mymail.mymail-app.workers.dev/api/v1/mcp", "--header", "Authorization:${MYMAIL_AUTH}"],
      "env": { "MYMAIL_AUTH": "Bearer mm_live_YOUR_AGENT_KEY" }
    }
  }
}
```

Restart Claude Desktop. The MyMail tools appear under the tools menu.

## Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "mymail": {
      "url": "https://mymail.mymail-app.workers.dev/api/v1/mcp",
      "headers": { "Authorization": "Bearer mm_live_YOUR_AGENT_KEY" }
    }
  }
}
```

## ChatGPT and the OpenAI API

ChatGPT's connectors in developer mode sign in with OAuth, which MyMail doesn't offer yet. With the
OpenAI API (Responses API or the Agents SDK), use the remote MCP tool with a header:

```js
const response = await openai.responses.create({
  model: "gpt-5",
  tools: [{
    type: "mcp",
    server_label: "mymail",
    server_url: "https://mymail.mymail-app.workers.dev/api/v1/mcp",
    headers: { Authorization: "Bearer mm_live_YOUR_AGENT_KEY" },
    require_approval: "never",
  }],
  input: "Check my agent inbox for a verification code from Acme and tell me what it is.",
});
```

`require_approval` there is OpenAI's own prompt. MyMail's approval queue still decides whether a
send goes out.

## Testing it

```sh
npx @modelcontextprotocol/inspector
```

Choose Streamable HTTP, paste the URL, and add the `Authorization` header.
