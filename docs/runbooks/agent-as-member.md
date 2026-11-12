# An AI agent that joined as a person (AIS1)

Audit of 11 Nov 2026, row 1. Before AIS1 an API key could invite an agent inbox address, the agent read the
invite and the "Confirm your email" link from its own feed, and the address became a normal member with a
seat and mailbox access, outside the agent's approval rule, send cap and allow list. AIS1 refuses that on
every path (see docs/api.md, "An agent can't become a person"). It does not remove members made before.

## Find them (reads only)

- In a workspace: Settings, Team shows an amber AI badge on such a member (`agentInbox: true` on
  `GET /api/team` members, `GET /api/v1/people` and MCP `list_people`).
- Across the platform (operator):
  `npx wrangler d1 execute mymail-au --remote --command "SELECT m.organization_id, o.name, u.id AS user_id, u.email, m.role, m.created_at FROM members m JOIN users u ON u.id = m.user_id JOIN organizations o ON o.id = m.organization_id JOIN mailboxes mb ON mb.address = lower(u.email) AND mb.kind = 'agent' JOIN domains d ON d.id = mb.domain_id AND (d.status = 'verified' OR d.verified_at IS NOT NULL) WHERE m.kind = 'human'"`
  This matches the agent inbox address itself, on a domain its owner proved in DNS (the rule the AI badge
  uses, agentInboxIdAt in src/server/services/agents/agent-address.ts). An agent inbox on a domain claim nobody
  verified gets none of that address's mail, so the member there is a real person: leave them. A `+tag`, an
  alias or a catch-all that reaches an agent is refused for new invites but is not listed here.
- Refusals since AIS1:
  `npx wrangler d1 execute mymail-au --remote --command "SELECT org_id, action, actor_email, metadata, created_at FROM audit_logs WHERE action IN ('member.invite_refused', 'member.join_refused', 'account.signup_refused', 'guest.invite_refused', 'guest.join_refused') ORDER BY created_at DESC LIMIT 50"`

## Fix (the workspace owner)

Removing a member is the owner's call, so nothing here deletes anyone. The owner (or an admin) removes the
member in Settings, Team, and checks its sessions, API keys and mailbox access went with it. The agent
itself stays in Agents with its own approval rule, send cap and allow list.
