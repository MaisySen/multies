import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { callerKind, isPersonSession, requirePerson, type CallerLike } from "@/server/lib/actor-kind";
import { resolveApiKey } from "@/server/services/developer/api-keys";
import { HttpError } from "@/server/lib/errors";

// AIS1: the shapes below are what each resolver really returns (api-keys.ts resolveApiKey, oauth.ts
// resolveOAuthToken, agents/index.ts asAgent, routes/mcp.ts for the "mcp:" prefix).
const person: CallerLike = { userId: "usr_1", role: "owner", sessionId: "k3Jd92mQzX" };
const workspaceKey: CallerLike = { userId: "usr_1", role: "admin", sessionId: "apikey:key_1", apiKeyId: "key_1", agentId: null };
const agentKey: CallerLike = { userId: "usr_1", role: "admin", sessionId: "apikey:key_2", apiKeyId: "key_2", agentId: "agt_1" };
const agentMemberKey: CallerLike = { userId: "usr_agent", role: "member", sessionId: "apikey:key_3", apiKeyId: "key_3", agentId: null };
const oauth: CallerLike = { userId: "usr_1", role: "owner", sessionId: "oauth:grant_1", apiKeyId: "oauth:grant_1", agentId: null };

describe("AIS1 callerKind", () => {
  it("names each kind of caller", () => {
    expect(callerKind(person)).toBe("person");
    expect(callerKind(workspaceKey)).toBe("workspace_key");
    expect(callerKind(agentKey)).toBe("agent_key");
    expect(callerKind(agentMemberKey)).toBe("agent_member_key");
    expect(callerKind(oauth)).toBe("oauth");
    expect(callerKind({ system: true, userId: "usr_1" })).toBe("system");
    expect(callerKind({ userId: "" })).toBe("system");
    expect(callerKind({})).toBe("system");
  });

  it("a connected AI app is not a person although it carries the person's id, email and role", () => {
    expect(isPersonSession(oauth)).toBe(false);
    expect(isPersonSession(person)).toBe(true);
  });

  it("keeps the answer when the MCP route rewrites the session id to mcp:...", () => {
    expect(callerKind({ ...workspaceKey, sessionId: "mcp:apikey:key_1" })).toBe("workspace_key");
    expect(callerKind({ ...oauth, sessionId: "mcp:oauth:grant_1" })).toBe("oauth");
    expect(callerKind({ ...agentKey, sessionId: "mcp:apikey:key_2" })).toBe("agent_key");
  });

  it("falls back to the session id when the key fields are missing, with or without the mcp: prefix", () => {
    expect(callerKind({ userId: "usr_1", role: "admin", sessionId: "apikey:key_1" })).toBe("workspace_key");
    expect(callerKind({ userId: "usr_1", role: "admin", sessionId: "mcp:apikey:key_1" })).toBe("workspace_key");
    expect(callerKind({ userId: "usr_a", role: "member", sessionId: "apikey:key_3" })).toBe("agent_member_key");
    expect(callerKind({ userId: "usr_1", role: "owner", sessionId: "mcp:oauth:grant_1" })).toBe("oauth");
  });

  it("an agent's own send is an agent even when it carries its maker's or approver's user id (PRIV1b P31)", () => {
    expect(callerKind({ userId: "", role: "admin", sessionId: "agent:agt_1" })).toBe("agent");
    expect(callerKind({ userId: "usr_1", role: "admin", sessionId: "agent:agt_1" })).toBe("agent");
    expect(callerKind({ userId: "usr_1", agentId: "agt_1" })).toBe("agent");
  });

  it("works for a SuiteActor, which has no session id", () => {
    expect(callerKind({ userId: "usr_1", role: "member" })).toBe("person");
    expect(callerKind({ userId: "usr_1", role: "admin", apiKeyId: "key_1" })).toBe("workspace_key");
    expect(callerKind({ userId: "usr_1", role: "owner", apiKeyId: "oauth:grant_1" })).toBe("oauth");
    expect(callerKind({ userId: "", agentId: "agt_1", apiKeyId: "key_2" })).toBe("agent_key");
  });

  it("automations that act for a person (a mail rule, a schedule, a demo seed, a data move) still read as that person", () => {
    // None of these reaches a people-only rule today. This pins the behaviour so a new caller is a deliberate choice.
    expect(callerKind({ userId: "usr_1", role: "member", sessionId: "rule:rul_1" })).toBe("person");
    expect(callerKind({ userId: "usr_1", role: "owner", sessionId: "demo" })).toBe("person");
    expect(callerKind({ userId: "usr_1", role: "owner", sessionId: "" })).toBe("person");
  });
});

describe("AIS1 requirePerson", () => {
  it("lets a person through and refuses every other caller with 403 person_only", () => {
    expect(() => requirePerson(person, "Letting an agent send without approval")).not.toThrow();
    for (const caller of [workspaceKey, agentKey, agentMemberKey, oauth, { system: true }, { userId: "", sessionId: "agent:agt_1" }]) {
      let err: unknown;
      try { requirePerson(caller, "Letting an agent send without approval"); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(403);
      expect((err as HttpError).code).toBe("person_only");
      expect((err as HttpError).message).toBe("Letting an agent send without approval needs a person signed in to Multies. An API key or a connected AI app can't do it.");
    }
  });
});

describe("AIS1 callerKind on a real workspace key", () => {
  it("classifies what resolveApiKey returns, before and after the MCP session id rewrite", async () => {
    const { app, deps } = await makeTestApp();
    const u = new Client(app);
    await u.signup();
    const made = await u.post("/api/developer/keys", { name: "script" });
    expect(typeof made.body.secret).toBe("string");
    const actor = await resolveApiKey(deps, `Bearer ${made.body.secret}`);
    expect(actor).not.toBeNull();
    expect(callerKind(actor!)).toBe("workspace_key");
    expect(callerKind({ ...actor!, sessionId: `mcp:${actor!.sessionId}` })).toBe("workspace_key");
    expect(isPersonSession(actor!)).toBe(false);
  });
});
