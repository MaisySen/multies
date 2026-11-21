# Device networking consent records, isolated experiment

This is a separate own-user authenticated DATA composition, not working networking.
It records consent under the original live browser session. Listing a record does
not enable a network, discover a native device, register a key or issue authority.
All successful API responses say networkingEnabled:false, authorityGranted:false
and mode:recorded-consent-session-bound-data. There is no UI, native/registrar
link, witness consumer, traffic grant, credential, carrier, renewal or duration.
Do not describe this as background, ongoing or logout-independent approval.

## Isolation and installation

Nothing in src/, drizzle/, schema.ts, generated migrations or normal createApp
imports this experiment. Normal app routes remain absent even when the installer
has been explicitly used in a disposable harness. No endpoint flag is offered as
an isolation claim: installing triggers into a real DB would affect source writes
even if endpoints were off. Instead, the only installer accepts a process-owned
store made by its own factory and held in a WeakSet. It accepts no DB path, remote
binding, account, URL or arbitrary connection.

Node factory creates a new private mkdtemp directory, random ownership sentinel
and file DB, applies existing normal schema, and checks realpath parent plus sentinel
on every access. Local D1 factory creates a fresh Miniflare/workerd instance and
unique owned binding ID, with no remote proxy/connection or persistent external
DB configured. Ownership evidence records kind, UUID and physical path or binding
ID. No arbitrary store or cloned object can be installed. A lost sentinel fails.
Trusted code can still modify methods/schema; this is mechanical harness safety,
not protection against malicious code in the same process.

Installer refuses ANY preexisting rel_* object, including accepted prior proof
objects or an unknown marker. It does not adopt/import/reset them. It builds the
accepted source triggers/tables minus rel_witness, adds strict digest CHECK,
partial unique index and exact CHECK-constrained version marker in ONE real
SQLite transaction or D1.batch. Fault at batch end rolls back marker and every
rel object. Startup verifies exact marker and absence of witness; DB identity must
match the actual auth dependencies for the authenticated composition (Node only).
Marker is not tamper detection or backup antirollback. No production install occurs.

## Actual authenticated surface

Only this separately constructed Hono app has /api/consents POST/GET and
/api/consents/:id DELETE. Tests use real signed cookies issued by the normal app
on the SAME owned file DB. mnetPerson resolves actual Better Auth session with
cookie cache disabled, then actual DB session expiry/nonimpersonation; generic
requireAuth and its possible workspace bootstrap/cache are not used. Body userId,
actorId or sessionId cannot select an actor. Each SQL operation also correlates
the authenticated session and DB-clock unexpired/nonimpersonated actor.

The real csrfGuard is mounted explicitly, followed by the existing handoff rate
limiter, keyed by IP and counting reads:20 requests/minute in this candidate.
Bad Origin and Origin-less cross-site fetch are denied. Header-less nonbrowser
requests remain allowed by that existing guard, requiring actual cookie and strict
bounded JSON for mutation. IP trust normalization beyond this isolated harness
is not a deployment claim. Responses are no-store/no-referrer. GET does not create,
revoke or refresh consent, though existing auth session refresh/rate-limit counters
can write. No forwarding/CORS/remote exposure configuration is added.

POST strictly accepts exact workspaceId, deviceDigest64-lowercase-hex and
explicit:true, using existing duplicate-key rejecting, UTF-8 strict8KiB reader.
DB CHECK independently enforces digest shape. Digest is only a caller label, not
a bound enrolled key or evidence of device ownership. New record IDs are generated
server-side with existing randomToken. Existing recorded joining approvals are
not reused. Atomic initialize+INSERT SELECT rechecks original session/current
eligibility/SSO/fence. No app-side eligibility pre-read authorizes a write.

At most4 approved records and8 lifetime historical records per user, checked
inside INSERT. No purge/reset/retention job. Reaching history cap denies new
recording; that intentionally makes this small experiment finite. A partial UNIQUE
index enforces one approved tuple per exact user/workspace/digest. Conflict uses
ON CONFLICT(user_id,workspace_id,device_key_digest) WHERE status='approved' DO NOTHING,
never parses exceptions. An approved but ineffective record still occupies its
slot. Repeated explicit POST never changes original session/login/fence or refreshes
consent. Revoke first, then explicit reapprove under a current session, creating a
fresh ID and retaining the old tombstone. No silent replacement.

POST performs an actor-scoped current readback. Its result inserted-at-read or
already-recorded-at-read is explicitly momentary, with statusAtRead:true and current
recordedStatus/validity. A commit between insert and readback can mean inserted-at-read
with recordedStatus:revoked. If a conflicting record is revoked before readback,
return409 consent_not_recorded rather than claim approval. Re-list after mutations;
no response promises record status remains unchanged after its query. Lost response
can be reconciled with own list, not a bearer recovery secret.

GET lists only that actor's records, even after membership loss. It returns4 records
per page with a43-character exact-ID cursor; history is bounded8. Pages are current
reads, not a consistent multi-page snapshot. Derived validity distinguishes revoked,
original-session-ended, security-fence-changed, current-eligibility-unmet, sso-blocked
and currently-valid-session-bound-data. No generation/session ID/password/hash
internals are exposed. Query failures are503 unavailable, not fabricated revocation.
Recorded approved status and effective validity are deliberately separate.

DELETE rechecks exact own-user actor in the conditional UPDATE and then own-scoped
readback. Membership not required; repeated own revocation is idempotent. Missing
and foreign IDs have the same controlled refusal, with no admin cross-member power.
List remains available to discover/revoke records after membership loss.

## Clocks, security and explicit limitations

Validity SQL uses DB Unix milliseconds from accepted DB_NOW_MS. Source schema
expires_at is timestamp_ms. Actor/approval require expiry>DB now; original-session
expiry<=DB now gives ineffective. SQL now is stable per statement. Original-session
equality is pinned with a CTE supplying exact same-statement DB now, not sleeps or
browser time. Existing resolver also has an app-clock check: an app clock ahead may
conservatively deny authentication; an app clock behind cannot extend DB validity.
This is not silently choosing the permissive clock. No timer/expiry propagation or
traffic withdrawal is implemented.

Candidate securityPolicy:source-write-only. Actual covered source writes trigger
per-statement invalidation, not after-hook/audit authority. Deleting ANY active
session globally invalidates all this user's consent records, deliberately stronger
than legacy. Expired cleanup does not globally fence, while original-session expiry
still makes its own record ineffective. Role/SSO changes sticky-revoke. This is a
conservative candidate policy, NOT approved production logout semantics.

Zero-row revoke-other intent is NOT covered, explicitly exposed by
noOpSecurityIntentCovered:false. External IdP password reset/compromise reports
without covered writes and noncredential OAuth unlink are not detected. No command
intent gateway or complete security-event promise. Trusted source REPLACE remains
unsupported; accepted textual source scan is not dynamic SQL/migration enforcement.
Snapshots restore approval/fence together and can replay old authority: no antirollback.
A later proper sessionless product requires a separate complete security/rollout design.

## Evidence, exact scope

Changed boundaries first: real-cookie authenticated tests, then local D1 SQL tests,
then mid-call committed-revoke/marker tests. One grouped regression passed50/50:
14 then-current authenticated cases +2 local D1 cases +34 unchanged original bridge
and joining-consent cases. A subsequent test-only equality/pagination case passed
focused (other14 skipped), bringing authored authenticated cases to15. No second
legacy grouped rerun for that test-only addition. Final new-file ESLint and strict
SQL-only typecheck pass.

Typecheck caveat: the full experimental tsconfig imports real auth/app dependencies.
Its first attempt exhausted default ~1GiB Node heap; bounded2GiB retry was killed by
available memory. Neither is a typecheck pass. Logs retained. sql.ts plus its accepted
pure SQL dependency pass strict TypeScript independently. Runtime transpilation/tests
and ESLint do NOT replace a full auth/composition typecheck or release build.

Tests pin actual CSRF/content parser, request21 rate denial, foreign/missing identity,
impersonated/expired cookies, current new-session revoke/reapprove after old-session
expiry, membership-loss list/revoke, approved/history limits, duplicate provenance,
concurrent duplicate API requests and committed revoke between POST commit/readback.
Mechanically owned installation tests cover unknown/adopted schema, marker batch
rollback, physical sentinel loss and auth/store mismatch. Default sqlite_master
(tables/indexes/triggers SQL) is compared around experiment import; static src scan
pins no new normal imports and normal createApp route remains404. Normal source and
migration tree are unchanged against a737e8a.

Local D1 evidence is the new SQL only, not full Hono/cookie auth parity. Fresh owned
local binding runs exact partial-index conflict syntax, actor-scoped list/revoke,
digest CHECK, atomic schema/marker rollback and concurrent approved/history cap batches.
No remote service or full accepted store/D1 matrix rerun. Existing proofs remain as
previously scoped. Initial suite transform failed on a quote typo, corrected before
passing; failure logs retained. No failed run counted as passing.

Reproduce:

    node node_modules/vitest/vitest.mjs run tests/mnet-consent-records.test.ts tests/mnet-consent-records-d1.test.ts
    node node_modules/typescript/bin/tsc -p experiments/mnet-consent-records/tsconfig.sql.json
    node node_modules/eslint/bin/eslint.js experiments/mnet-consent-records/*.ts tests/mnet-consent-records*.ts

Full check needing more memory, currently unverified:

    node node_modules/typescript/bin/tsc -p experiments/mnet-consent-records/tsconfig.json

Independent exact-artifact review before further integration. Production schema,
route registration, migration, operator enablement, real consent and actual networking
are all held. This is useful authenticated consent DATA, not background connectivity.
