# Disposable authoritative approval/revocation store proof

Engineering candidate only, based on Multies cb40db3. No application importer,
production schema edit, generated migration registration, config selector,
endpoint, credential, traffic carrier, renewal, duration or real activation.
Only tests install schema.sql into disposable databases. The SQL witness records
assertion DATA, not access. Do not consume it as a capability or traffic permit.

## Ownership and atomic boundaries

rel_security holds server-owned user security generation plus a disabled bit.
The checked integer range is 0..9007199254740991, the actual JS safe-integer limit,
not SQLite's larger int64 range. A fence at that limit disables future approvals,
never wraps. No recovery/restore/operator UI is introduced. A fence may increment
more than once in a workflow (including OLD/NEW for the same user); it is not an
event count or complete event log.

rel_approvals holds exact subject/workspace/membership IDs, device digest,
approving session provenance, approval login method and security generation.
No user-source FK can cascade-delete these rows. Revoked rows cannot be updated
back to approved; security-binding fields are immutable through UPDATE. Each new
explicit approval has a new caller-generated, server-owned ID. This experiment
passes IDs in tests, not an ID-generating public API. Trusted server code owns
SQL access. Direct malicious writes to these authority tables, trigger/schema
changes, backups and REPLACE are outside its boundary. No SQL function authenticates
a person merely because a caller knows a session ID.

approvalBatch returns exactly two prepared statements: INSERT OR IGNORE to
initialize security using a live nonimpersonated source session, then conditional
INSERT...SELECT approval with current generation and all current eligibility
facts in that statement. Both MUST run in one actual atomic D1.batch, or a real
synchronous SQLite driver transaction. No app runBatch fallback is used. A denied
approval can leave an initialized security row but no approval. A failed batch
rolls back both. The authenticated server must first resolve the real session;
these SQL statements recheck it, they do not authenticate caller-controlled IDs.
Explicit approval is not inferred from any existing joining consent.

witnessSql inserts assertion DATA only when immutable approval, security fence
and current joined user/member/workspace/SSO facts hold in that one statement.
For this conservative proof it ALSO requires the approving session to remain
present, unexpired and nonimpersonated. This intentionally retains the original
session-dependent floor. No logout-independent or ongoing product mode is built.
Past witness rows remain historical DATA when later revoked; there is no traffic
withdrawal, cache lifetime or distributed commit promise.

Own revoke uses the actual authenticated nonimpersonated actor's current session,
checks exact approval ownership, and needs no workspace membership. Already
revoked rows remain revoked (zero changes); no cross-member admin power exists.

## Source invalidation, per statement only

Experimental source-table triggers run in the same statement as the mutation.
A trigger error rolls back that source statement; no after-hook/audit is authority.
Each trigger lists exact UPDATE OF fields and compares OLD/NEW for no-op writes:

- Credential account insert/password change/unlink/delete fences that user.
  Credential ownership/provider/key changes also fence OLD/NEW subjects. Normal
  noncredential refresh does not. setPassword server API is covered by actual writes.
- Deleting an active session fences the user conservatively. Deleting an expired
  session does not. Identity/login/impersonation changes or expiry reduction fence;
  ordinary session refresh/expiry extension does not. The witness still denies an
  expired approving session even if no cleanup event occurred.
- User deletion, ID/email change, verification loss or ban fences. Reverification
  and unban do not resurrect old approvals. No request-email-as-identity inference.
- Membership ID/subject/workspace/role/kind/disabled change or deletion sticky-revokes
  approvals for that membership. Restoring a prior role does not undo revocation.
- Workspace ID/SSO change, suspension set/change or demo enablement sticky-revokes;
  deletion also revokes. SSO both directions invalidate, intentionally conservative.

DB clock: source expires_at uses actual schema timestamp_ms integers. SQL computes
Unix milliseconds using SQLite strftime seconds plus its three fractional digits,
not browser time, JS Date.now or rounded seconds. Approval/witness use expires_at
strictly greater than DB now. A deletion at equality is conservatively counted as
a revoke, using >=. A race around that millisecond can conservatively invalidate;
there is no stale application pre-read. Each statement has its own DB-time instant.
No automatic timer/event on crossing expiry is claimed.

This is a candidate policy, not approved product logout behavior. An unrelated
active-session deletion can revoke every candidate approval for that user, more
than legacy. Role/SSO changes are also stricter than legacy automatic restoration.
Ordinary expired-session cleanup is expressly not that global fence.

Better Auth workflows contain multiple SQL statements, and the app disables
interactive adapter transactions for D1. Only each actual source statement and
its trigger are atomic here. A crash after one committed mutation leaves the
fence committed; a crash before commit rolls that statement back. An explicit
approval between workflow statements is new approval at that intermediate state,
not proof the whole workflow finished. A later relevant mutation revokes it.
No overall revoke/approve linearization across an entire auth workflow is claimed.

No-op security intent is genuinely incomplete: revoke-other with no other sessions
changes no source rows, so triggers do not fence. No command gateway has been
implemented or claimed to cover HTTP/server API. Provider-side password resets,
compromise reports and remote events without a local covered write are not detected.
These need a separate trusted command/event design before any product consumer.

REPLACE is unsupported. With recursive triggers off, replacing a session can skip
DELETE-trigger invalidation and preserve a witness. The adversarial test explicitly
exhibits this, not a passing security claim. Static src scan finds no REPLACE on
protected users/accounts/sessions/members/organizations. An unrelated drive_blobs
REPLACE exists and is not forbidden. UPDATE/UPSERT statements take UPDATE triggers.
Future source changes or migrations must honor this boundary. The proof does not
prevent a trusted SQL writer from violating it.

Delete/recreate retains authority tombstones with plain source IDs and no FK cascade.
The original approval remains revoked even if identical source IDs reappear; fresh
explicit reapproval can create a new row at the retained fence. Snapshot restore is
NOT protected: restoring both rows and fence replays prior authority. A test demonstrates
that exact limitation. No antirollback authority, database-restore safety or adoption.

## Evidence and scope

Changed boundaries first, then one grouped regression: 78/78 across35 store tests,
8 actual installed-auth tests,1 actual local workerd D1 test and34 unchanged original
Mnet device-bridge/consent tests. Scoped store/fixture strict TypeScript and new-file
ESLint pass. No full app build. No production source/migration changes.

- SQLite competing writer threads hold an actual IMMEDIATE write lock and attempt
  another transaction before release: approve then mutate, mutate then approve and
  two concurrent first approvals serialize. This is local SQLite evidence, not a
  remote-D1 contention/load claim.
- Child Node processes are SIGKILLed after committed source mutation versus while
  that mutation/trigger are inside an uncommitted transaction. Reopened reads deny
  after commit and retain old state after rollback. No claim of killing D1/workerd.
- Failure injection aborts the trigger's security update, proving original source
  mutation and fence rollback together. Forced batch failure rolls initialization
  and approval back together. Driver-safe overflow fails closed.
- Actual Better Auth1.7.12 runs setPassword server API, changePassword both flags,
  reset, all-session revoke, other-session/no-op revoke, failed password, disabled
  email change, owner transfer and SSO HTTP changes in real app disposable schema.
  Set-password/no-flag change preserve source session yet fence via credential write;
  change with revoke flag/reset remove original session. MCP hooks are not Mnet hooks.
- Actual local D1 binding via Miniflare/workerd executes the SAME store SQL/triggers,
  real D1.batch first-approval rollback, failed-source rollback, credential fence,
  expired cleanup and cascaded user deletion. Its source tables are the narrow
  fixture with actual names/units/FKs, not the complete app schema. This is local
  emulator evidence, not remote deployment/full D1 workflow or workload parity.
  Initial local-D1 harness launches failed due to Miniflare API shape, corrected by
  its installed convertV4MiniflareOptions API before the passing run. No failed run
  is counted as passing; initial logs are retained in packet.

Source constraints: src/server/auth/options.ts (adapter transaction:false, security
hooks, reset option); src/server/services/mnet.ts (correlated original session path);
src/server/db/schema.ts (source fields/units), services/team.ts (two-step transfer).
D1 batch contract: https://developers.cloudflare.com/d1/worker-api/d1-database/ .
Trigger support is grounded by local execution and existing drizzle0087/0088/0119,
not inferred from https://developers.cloudflare.com/d1/sql-api/sql-statements/ .

Reproduce from repo with existing dependencies:

    node node_modules/vitest/vitest.mjs run tests/mnet-relationship-store.test.ts tests/mnet-relationship-store-auth.test.ts tests/mnet-relationship-store-d1.test.ts tests/mnet-device-bridge.test.ts tests/mnet-enrollment-consent.test.ts
    node node_modules/typescript/bin/tsc -p experiments/mnet-relationship-store/tsconfig.json
    node node_modules/eslint/bin/eslint.js experiments/mnet-relationship-store/*.ts tests/mnet-relationship-store*.ts

Independent exact-artifact review is required before any further integration.
Production migration/rollout and actual explicit operator/device approval remain
closed. This proof solves local storage/order mechanics, not product activation.
