# Development service status/ack historical bookkeeping

Status: implemented separate branch only, off by default and development-only.
No external service/account/config change, Store commit, daemon adapter, native
receipt endpoint, key-possession call, node/network authority, tunnel, screen/input
permission, audit projector, production policy, release or deployment.

Baseline was reserve-only7bb2b03b. Parent accepted the bounded next-slice plan;
that direction is not a grant to activate anything. Independent reserve review
executed Python vector and SQLite SQL/migration checks, not our full test suite.
This checkpoint's builder validation is stated below separately.

## Actual bounded behavior

New POST `/api/mnet-enrollment-service-v1/status` and `/ack` share existing
separate header authentication, body-size/strict-duplicate JSON reader, feature,
operator-config and production refusal. Status/ack require exact handoff/attempt/
reserve/descriptor. Ack additionally requires canonical32byte receipt ID/digest.
No public metadata alone authenticates a caller. No cookie/browser/native caller
is admitted as a service. No ticket/secret redelivery. No new authority response.

The current active service key must match the record's pinned service identity,
issuer, registrar origin and audience. Rotated active keys for that SAME scope
may report it. Revoked key/identity or changed scope refuses. Configuration must
still be enabled and structurally valid. Workspace mapping changes do not rewrite
historical binding. Deleted user/session/member/workspace does not prevent the
same active pinned registrar recording what it claims happened already. Reserve
still requires current live eligibility; bookkeeping does not.

Acknowledgement is a trusted registrar's CLAIM of durable commit, not independent
proof its disk committed. No real registrar Store is connected. Every status/ack
result explicitly includes `authorityGranted:false` and `enrolled:false` even
when historical journal status is consumed. It is not permission for current
network access. Receipt fields identify the reported historical result only.

On-time exact ack: reserved->consumed. At now>=deadline: authenticated status/ack
first records reserved->uncertain once; matching late ack records uncertain->
consumed. A crash between those individual atomic statements leaves uncertainty,
not a new reserve. A deadline crossed during an ack UPDATE refuses that request;
a later retry records uncertainty before consumed. No timeout resets, deadline
extension, new ticket, reserve replacement, current-eligibility renewal or node
action follows. No background clock guarantee: uncertainty is request-driven.
An untouched expired reserve can remain physically reserved until a service call.
It cannot be used by the reserve retry path after its deadline.

Identical consumed receipt retry returns the same result without another event.
Changed receipt ID/digest/descriptor/reserve refuses. Issued/unreserved/pending
rows cannot be acknowledged. Invalid auth/body/budget does not mutate history.
Repeated reads/retries/auth failures create no journal lifecycle event.

## Migration, events and capacity

0175 rebuilds0174's CHECK for uncertain/consumed and adds receipt ID/digest,
descriptor encoding version and eventSeq. Existing legitimate seq1reserve events
are preserved verbatim and versioned1. Existing nonreserved rows must have no
reserve event. A count guard makes malformed old sequences abort the entire
migration instead of silently omitting them. All indexes are recreated. No
preview row conversion, cascade or destructive retention change.

SQL bounds JSON events to an array length<=8 equal to eventSeq. Service validates
the expected lifecycle sequence before historical updates. Reserve appends seq1;
uncertainty seq2if needed; ack seq2or3. State+append+seq increment occurs in one
conditional UPDATE. Conditional losers reread the exact winner; differing
receipts do not append another result. JSON and event sequence remain bounded.

Enabled service fixture config now requires explicit per-operation authenticated
service budgets and eventCapacity>=3. Old insufficient config refuses rather
than being silently expanded. New admission reserves all possible lifecycle slots.
Historical bookkeeping uses preserved physical8slot storage and fixed max3event
lifecycle, NOT mutable admission capacity. Tests reserve under capacity8then
reduce it to3and still reconcile. No overwrite or pruning makes room.

Existing cleanup explicitly excludes reserved/uncertain/consumed. Their retention
and operator recovery remain unselected; indefinite fixture preservation is not
production privacy policy. One immutable event record is not a working org audit
pipeline: sink cascade, idempotent projection, delivery failure and deleted-org
handling are still held. No event plaintext ticket, service/native secret or
PKCE verifier is stored.

## Budgets and stacked guards

Required `serviceBudgets` object has reserve/status/ack limits, each explicit in
fixture config. After authenticating, a shared DB counter uses configured
serviceId+operation, so key rotation cannot reset identity budget. Invalid auth
cannot charge a victim's service-specific budget, though it still spends shared
IP/global limits. Status exhaustion does not consume ack's configured budget.

The existing separate IP abuse ceiling and inherited global app300/min guard
remain stacked, no bypass. Same-IP/global starvation is still possible. This is
measured local fixture behavior, not production fairness/throughput or distributed
limit correctness. No credential or ticket is a counter/log key. Thresholds are
not production defaults.

## Executed validation

- Failing-first actual deadline/status test returned404 before handlers existed;
  the same scenario now records uncertainty/late exact receipt.
- 66selected tests across five files pass:18new bookkeeping,22affected reserve,
  21existing journal,4config,1descriptor vector. After an explicit migration
  statement-separator cleanup, the3affected SQLite migration/local-D1 tests were
  rerun and pass. No stopped List lifecycle material was touched.
- Changed-source lint and strict affected server-entry typecheck at4GiB pass.
  Full repo/test-graph typecheck and external security certification unclaimed.
- Exact before/at deadline, clock crossing during ack, direct/late receipt,
  concurrent status+same/different receipts, identical retry, active rotation,
  revoked service, changed scope and deleted user/session/member/workspace/mapping
  tested. Recorded historical results never assert new authority or enrollment.
- SQL trigger aborts separately at uncertainty and ack event writes. Each state
  and event remains unchanged on its failed statement. Retry succeeds after
  fixture trigger removal. No test trigger goes into migrations.
- Actual SQLite backup/close/reopen/new handlers between uncertainty and ack
  preserves history and records one receipt. This is process reconstruction,
  not process-kill/power-loss durability evidence.
- 0175copy preserves old reserve/event data and physical capacity; malformed old
  sequence aborts atomically, old data/table remain. Sequence/JSON length CHECK
  refuses an eventSeq-only edit. D1 emulator test checks ALL recreated indexes.
- Actual installed local Miniflare/workerd executes selected0173->0174->0175,
  real reserve/status/ack JSON append/RETURNING/retry, plus trigger-induced
  uncertainty failure atomicity. Eligibility tables are minimal explicit source-
  matching fixture columns. Not a full app, deployed D1/Worker HTTP ingress,
  multi-region/concurrent writer, native or Store acceptance claim.
- Authenticated operation budget across key rotation and independent ack budget
  tested; inherited IP/app limiter evidence remains preceding reserve coverage.
  Existing raw duplicate Authorization/local HTTP checks also rerun in reserve.

## Historical D1 blocker, still open

Unmodified full migration chain still fails in installed local D1 at0073. The
independent reviewer ran all158baseline migrations on SQLite successfully. A
disposable local D1 A/B supports a parser-specific lead: ORIGINAL fails0073after
68applied migrations, VARIANT removes only a trailing double semicolon in the
IN-MEMORY copy of statement9and all158apply. No historical SQL/generated source,
driver, external database or production configuration changed. No claim that
unmodified full D1 readiness passed. New0175was tested in the isolated chain,
not substituted into a false full-app claim. Fixing historical source stays held.

## Remaining authority boundary

Service bookkeeping does not close the distributed Multies-check-to-Store-commit
window. No timeless allowed=true result or Store consumer was added. Durable
lease/revocation, trusted native allowed-map provisioning and state persistence,
node-control credential protocol, proof descriptor/adapter, atomic Store crash
behavior, legacy reusable-key isolation, audit delivery, physical cross-host and
OS acceptance and release authority remain unimplemented/unapproved here. The
exact implemented checkpoint must be reviewed before any Store/daemon connection.

## Exact-source vector reconciliation and explicit receipt scope

A later review reported562bytes and a missing platform element. Inspection of the
retained8d35ae28archive and matching committed source shows platform already
present after redirectUri; file SHA256 was
bda74a533d4e2b71566c597b36f8aa37caa4e4c0a91b8ea5beaf54dd43c1fef2.
The original vector test reran successfully before any edit. A full affected
66test suite also reran successfully. Reviewer execution versus transferred
archive reconciliation remains pending externally; this document does not infer
that the review reproduction actually ran this exact function.

The encoding has NOT changed. A named byte serialization helper now exposes the
same fixed-array bytes so tests assert570bytes,19fields, callback at index11,
platform at index12, and a changed platform producing a different digest. The
original expected digest is unchanged. No shorter vector was adopted to make a
failure disappear. This helper is not a proof adapter or consumer connection.

Receipt IDs are scoped to the exact immutable handoff/reserve/descriptor/service
record, not globally unique across all rows. No unique receipt index exists.
Every read/ack requires those pinned identifiers and active service scope.
A receipt ID alone is never a lookup credential, global commit identity or proof
of enrollment. A future real Store receipt protocol must either define its own
global scope/uniqueness or preserve this qualified tuple explicitly before a
consumer is connected. No implicit global uniqueness may be claimed from the
current field name.

A concurrent ack can lose its conditional update to deadline uncertainty and
return403even with an otherwise matching receipt. The caller must retry the
SAME exact receipt/descriptor; it must not allocate a new reserve or infer absent
commit. This is bounded fail-closed bookkeeping availability, not idempotent
success for every racing request. Current tests allow that403and verify exact
winner retry plus a single sequence. No renewed authority follows from retry.

### Next connected slice, still a plan rather than implementation

Before Store/daemon connection, use the existing real Store and daemon lifecycle
owner rather than another parallel fake registrar store. First inspect and design
single-writer locking, local persistence directory sync/post-rename uncertainty,
node+receipt+credential-digest atomicity and exact revocation/legacy-rejoin checks.
Use isolated failing-first Store tests for one exact descriptor/idempotent commit,
changed descriptor/receipt conflict, persistence failure boundaries and reopen.
That does not activate a routed consumer. Native pending intent/trust-map
snapshot/selection and credential protocol remain a separately grounded piece;
no service response can configure new origins. Only after these actual boundaries
and proof descriptor/adapter review could an installed local full journey be
attempted, followed by physical two-host acceptance. Service source reviews and
local SQL emulation do not replace those gates or production policy approval.
