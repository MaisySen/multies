/**
 * R45: the production test session's three settings (TEST_SESSION_TOKEN, TEST_SESSION_USER_ID, TEST_SESSION_ORG_ID).
 * Kept apart from routes/test-session-r45.ts so the Worker can bind them at boot without loading the route: the Worker
 * calls app.fetch without an env, so the route cannot read c.env there.
 */
export interface TestSessionEnv { token: string; userId: string; orgId: string }

/** The three settings, or null when the feature is off (any of them missing or the token too short). */
export function testSessionEnv(env: unknown): TestSessionEnv | null {
  const e = (env ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof e[k] === "string" ? (e[k] as string) : "");
  const token = s("TEST_SESSION_TOKEN"), userId = s("TEST_SESSION_USER_ID"), orgId = s("TEST_SESSION_ORG_ID");
  if (token.length < 32 || !/^usr_[a-z0-9]+$/.test(userId) || !/^org_[a-z0-9]+$/.test(orgId)) return null;
  return { token, userId, orgId };
}

let bound: TestSessionEnv | null = null;
/** The Worker's boot passes its string settings here; only the three test session values are kept. */
export function bindTestSessionEnv(vars: Record<string, string | undefined> | undefined): void { bound = testSessionEnv(vars); }
export function boundTestSessionEnv(): TestSessionEnv | null { return bound; }
