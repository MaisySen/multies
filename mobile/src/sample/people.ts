import type { Person } from "@/api/types";

/** GET /team/people for the sample workspace: two people, an AI agent member and the two mail agents. */
export function samplePeople(now: number): { people: Person[] } {
  const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const human = (id: string, name: string, email: string, role: Person["role"], title: string | null, bio: string | null, days: number): Person =>
    ({ id, type: "member", kind: "human", userId: id, agentId: null, name, email, role, title, bio, inbox: null, joinedAt: ago(days) });
  return {
    people: [
      human("usr_sample", "Mia Nguyen", "mia@harbourcoffee.com.au", "owner", "Founder", "Runs the roastery and the cafe floor.", 120),
      human("usr_josh", "Josh Tran", "josh@harbourcoffee.com.au", "member", "Operations lead", null, 60),
      { id: "usr_agent_books", type: "member", kind: "agent", userId: "usr_agent_books", agentId: null, name: "Bookkeeper", email: null, role: "member", title: "Finance assistant", bio: "An AI agent that reconciles invoices and flags late payers each Friday.", inbox: null, joinedAt: ago(7) },
      { id: "agt_invoice", type: "mail_agent", kind: "agent", userId: null, agentId: "agt_invoice", name: "Invoice chaser", email: null, role: null, title: "Mail agent", bio: "Follows up unpaid invoices politely.", inbox: "accounts-agent@harbourcoffee.com.au", joinedAt: ago(9) },
      { id: "agt_support", type: "mail_agent", kind: "agent", userId: null, agentId: "agt_support", name: "Support triage", email: null, role: null, title: "Mail agent", bio: "Answers order and opening hours questions.", inbox: "support-agent@harbourcoffee.com.au", joinedAt: ago(5) },
    ],
  };
}
