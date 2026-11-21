# Local enrollment service authentication and reserve checkpoint

Status: isolated branch implementation, default off, development only. No deployed
service, service provisioning, status/ack/reconciliation, native daemon adapter,
key-possession call, Store mutation, node authority, tunnel or screen/input action.
The preceding design review read source only and executed no tests. This document
records builder execution separately. Earlier journal/preview acceptance remains
its exact earlier source, not proof of this new service boundary.

## Actual API and authentication

New `POST /api/mnet-enrollment-service-v1/reserve` is gated by the existing valid
local handoff config/operator mapping plus a separate service flag and explicit
fixture config. `MNET_ENROLLMENT_SERVICE=on` requires development mode and valid
`MNET_ENROLLMENT_SERVICE_FIXTURE`. Required fixture fields: reserveMs,
eventCapacity, requestsPerMinute and keys. Every key contains keyId, serviceId,
active, digest, exact registrarOrigin/issuer/audience scope. No origin, credential,
lease, retention or capacity production defaults. Production startup throws;
runtime gate404s production, disabled feature or invalid/missing dependencies.

Authorization grammar is exactly `Bearer keyId.secret`, with a canonical random
32byte base64url secret. Key ID is public routing, not authority. The server hashes
the supplied secret and compares fixed-length digests with existing safeEqual,
then checks active configured identity/scope. Cookie and Origin are rejected.
Authentication precedes body parsing and ticket lookup. Errors are generic.
Request bodies reuse the existing8192byte fatal-UTF8 duplicate-aware strict JSON
reader. No secrets are accepted in query strings or service configuration fields;
only their digests. Test credentials are random disposable in-process values,
not real service accounts, vault credentials or externally provisioned secrets.
They are never printed or included in committed fixtures/evidence.

Fetch Headers can normalize surrounding whitespace before route code sees it.
The route rejects joined duplicate credentials/comma values and multiple schemes;
it cannot detect a prior proxy that silently discarded a duplicate. Actual local
Node HTTP ingress with duplicate raw Authorization lines is tested and refuses403.
That proves this installed adapter's behavior, not every reverse proxy or D1 ingress.

Dedicated fixture service budget is explicitly configured and IP-keyed in a
separate DB counter prefix. The inherited global app300/min limiter still stacks;
there is no silent exemption. It does not consume the separate handoff20/min
bucket. Invalid authentication counts against the service IP budget. This is not
real-use fairness, abuse hardening or an authenticated per-service budget design.
The tests demonstrate stacking/isolation/refusal, not production throughput.

## Immutable reserve and atomic event

Request contains ticket, handoffId, reserveId, original public launch tuple and
selected mapping. These are equality echoes against the code-bound journal;
registrar cannot choose another principal, session, key, mapping or service scope.
The ticket does not replace service authentication. No person provenance supplied
by a registrar becomes authoritative.

Descriptor encoding v1 is a fixed ordered JSON array of public strings plus the
literal numeric version, domain-separated by mnet-reserve-descriptor-v1. It binds
service identity, handoff/reserve, complete native launch and final mapping. The
ticket itself is not in the descriptor. No raw object serialization or property
order participates. A separate Python SHA256 calculation over the570byte fixed
vector agrees with the TypeScript function. That is encoding interoperability
coverage, not key-possession proof or protocol certification.

One conditional UPDATE transitions issued->reserved and simultaneously pins
service ID, unique reserve ID, descriptor digest, original deadline and a JSON
event append. WHERE requires unexpired ticket, same hash, empty initial event
sequence/capacity, unused reserve ID and correlated liveEligibility. Current
operator mapping/service scope is rechecked immediately before mutation. The
statement prevents competing descriptors from both winning. It cannot make
mutable external config and an independent SQL commit globally atomic. No Store
node commit occurs, so the later distributed authority window remains unsolved.

Exact live authenticated retry returns the same original reservation/deadline,
never a new ticket/event/deadline. Rotated active keys for the same exact service
identity/scope may repeat it; revoked keys or changed service identity refuse.
Changing tuple, reserve ID, mapping, principal eligibility or scope refuses.
Deadline expiry refuses; no timer resets the reservation. Failures do not use
pre-reservation withdrawal helpers. Reserved history is retained unchanged by
existing expiry/eligibility/scrub sweeps, including after session deletion.

Only one reserve event currently exists per record: seq1, unique random event ID,
service identity, handoff/reserve/descriptor/revision and timestamp. Event JSON
contains no ticket or credential plaintext. Existing events are never overwritten;
nonempty/capacity-exhausted initial sequences refuse the new authority transition.
Future append/reconciliation capacity/sequence rules remain held. There is no
outbox projector and no claim this supplies org audit for prepare/decision/exchange.
The existing org audit sink still cascades on workspace deletion and has no new
idempotent event-ID contract. Do not add projection before that separate review.

## Migration and retained uncertainty

Migration0174 rebuilds0173's table because its CHECK cannot accept reserved.
Existing row columns are copied explicitly; new reserve fields are null and
events default[]; unique code/ticket/attempt plus owner/retention indexes are
recreated, unique reserve index added. SQL CHECK bounds events to a JSON array
of at most8items. No consumed/uncertain/receipt states or status/ack endpoints
are added. Reserved state is sticky beyond deadline because status/reconciliation
is not implemented. It is incomplete, not proof that no remote commit happened.

The application migration driver runs each migration in a SQLite transaction or
D1 batch. Local failure injection proves a failed rebuild+tracking operation
rolls back table/data/index state. Existing row preservation is tested. This is
not a production migration execution or power-loss guarantee.

## Executed evidence and limits

- 47selected tests pass across reserve22, existing journal21 and existing config4;
  plus the independent descriptor-vector test passes. No stopped List test/review
  or unrelated held worktree was read, changed or retried.
- Strict affected server entry typecheck at4GiB and changed-source lint pass.
  Full repo/test-graph typecheck remains unclaimed.
- Concurrency: conflicting descriptors have one immutable winner; identical
  retries share its public metadata and single event. A reserve ID already used
  for another handoff refuses without a duplicate write/unhandled unique error.
- Auth failure verified before ticket SELECT by instrumenting actual SQLite
  prepare calls, not just result status. Joined/raw duplicate auth, malformed
  scheme, missing/wrong/revoked key, Cookie/Origin, duplicate JSON and oversized
  bodies refuse without reserving. Header normalization caveat remains above.
- Wrong tuple/scope/mapping/member/deadline/event capacity refuse with no reserve
  or new event. Valid-config production startup/runtime refusal tested. Status,
  ack/recover/consume paths remain404 with service enabled.
- Injected SQL trigger aborts event update. Both reserve state and event remain
  unchanged; after removing the fixture-only trigger, exact request succeeds.
  This trigger exists only in disposable test databases, not migration/source.
- Actual file-backed SQLite backup/close/reopen with newly constructed handlers
  returns the same reserve/deadline and one event. Not kill/power-loss durability.
- Dedicated service budget exhaustion does not consume handoff bucket; inherited
  app limiter still can reject before service processing. No rate-limit bypass.

### Local D1 execution, not deployed/full application D1

Installed Miniflare/workerd executes selected0173->0174 migrations and actual
Drizzle reserve JSON-append/RETURNING/retry/sweep statements successfully against
minimal explicit source-matching eligibility columns. This is local D1 emulator
SQL evidence, not full HTTP/worker deployment, remote D1 multi-writer/concurrency,
production migration, complete auth integration or audit sink evidence. The
fixture uses the installed runtime's supported compatibility date2026-10-26.
Miniflare is available through existing installed Wrangler dependencies; no new
package installation or external service access was used.

The first harness used old Miniflare constructor options; current installed API
requires its provided V4 converter. A requested fixture date newer than the
installed runtime was rejected; pinning its supported date fixed only that
harness startup, not product configuration or assertions.

The unmodified full historical application migration chain DOES NOT pass local
D1. A separate diagnostic identifies first failure at0073_r33_one_row_per_change
with D1 no-statement error. All11statements contain SQL; an initial comment-only
hypothesis was withdrawn after checking. Cause remains unresolved. No historical
migration, driver behavior or verification assertion was changed to hide it.
The successful isolated fixture deliberately excludes the full chain and is
labeled accordingly. This is a readiness blocker for full D1 acceptance.

Earlier initial test failures also exposed test assumptions: a POST without JSON
was correctly rejected by global CSRF/content-type middleware before feature404,
and Fetch normalized trailing authorization whitespace before our parser. Tests
now distinguish these observable boundaries without weakening product checks.
Old0173 CHECK refusal is asserted synchronously because Node Drizzle run throws
synchronously; no failure was converted into a passing product claim.

## Gates remaining

No service calls leave the local fixture, no externally usable credentials are
created, and nothing is pushed/deployed. Independent source review of the exact
reserve implementation remains required before any extension. Status/ack,
revoked-service operator recovery, full audit/outbox delivery, D1 full-chain
acceptance, native allowed-map trust provisioning/selection, saved native secret
protocol, Store crash semantics, proof binding/adapter and installed then physical
two-computer acceptance remain held. No native validation claim follows from
these server tests; no node/input/release authority follows from reservation.
