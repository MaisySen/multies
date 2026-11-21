# Local enrollment journal and PKCE checkpoint

Status: separate branch, default off, local development only. No deployment,
registrar, proof call, Store registration, node activation or normal setup entry.
Existing `/mnet/enroll` preview rows remain unredeemable. The installed native
preview command remains unchanged and does not launch this future handoff.

## Review reconciliation

The handoff contract review was source reading and design reasoning with no tests.
Its selected source packet predates the corrected preview and current proof v2.
Its two later-withdrawn authentication claims are superseded, not implemented:

- A verifier holding SHA256(secret) cannot verify HMAC keyed by the secret.
  HMAC keyed by the stored digest would turn the digest into usable authority.
- A registrar controlling commit/storage can ignore a supplied digest. Equality
  protects only within the stated honest-validator/trusted-registrar model,
  not against a malicious registrar itself.

Recovery authentication remains unselected. A future bearer design reveals the
secret to the receiving registrar during use despite hash-only storage. An
asymmetric replacement would need a new reviewed descriptor and protocol. Do
not call this proposed node-control credential status-only; its actual authority
is not selected or validated. No status route exists in this checkpoint.

Contract corrections before this code:

- Code delivery and exchange are strictly one-shot. Lost code or ticket response
  means a fresh native attempt and fresh consent, not redelivery from a hash,
  retry issuance or automatic credential rotation.
- Future `uncertain -> consumed` is permitted only as verified exact committed
  receipt bookkeeping. It must never renew authority, change a reserve or issue
  a ticket. Neither reservation nor reconciliation is implemented here.
- Current config wins on restart. A saved native intent must compare exact
  current origin/issuer/registrar/audience/revision/network before any retry.
  The native intent is not implemented here. Server restart tests below prove
  current-config refusal at the journal exchange, not native durable intent.

## Actual implemented boundary

`MNET_ENROLLMENT_HANDOFF=on` is independent of the consent-preview flag. It also
requires valid operator mapping plus `MNET_ENROLLMENT_HANDOFF_FIXTURE` with all
fields supplied explicitly. Production startup rejects enabling the handoff;
runtime handlers also refuse production mode or missing/invalid fixture/config.
There are no production timing, capacity or retention defaults.

New `/api/mnet-enrollment-v1` routes implement strict launch info, session-bound
prepare, one-winner person decision and code+PKCE exchange. Browser handoff page
is `/mnet/enroll-v1`. It requires exact full device key, attempt, credential
digest, correlation state, fixed literal IPv4 loopback callback and independent
PKCE challenge. Displayed operator values are equality guards against current
server mapping, never authority supplied by the browser. Native exchange rejects
cookies, Origin and Authorization headers. Bad tuple/PKCE does not spend a
still-valid owner's code. It is not proof of device-key possession or proof
that a native secret was saved. No claim from a browser can establish either.

New migration0173/table `mnet_enrollment_handoffs` is not session/user/workspace
cascaded. Version/purpose and status CHECKs are in SQL. Unique attempt/code/ticket
hashes and conditional transitions yield one winner. Prior preview rows are not
converted or accepted as this handoff's decisions. The current implemented
states stop at `issued`, plus pending/approved/declined/expired/withdrawn. No
future reserve/uncertain/receipt fields are frozen prematurely in this schema.

Both code and ticket are stored only as hashes and delivered only once. The
issued ticket has no consumer. It is not a node credential, List credential,
proof or input permission. No service/reserve/status/ack/recover/consume route
is present. The browser result says not joined and registrar not connected.

## Explicit fixture policy and privacy limits

The acceptance fixture supplies consent600000ms, code60000ms, ticket120000ms,
full-terminal-row86400000ms, per-person capacity10, total rows100 and retention
mode `terminal-hash-tombstone`. These are disposable fixture choices, not approved
product policy. Schema validation bounds values and requires every field.

Request-driven cleanup expires pre-reservation states at their exact deadlines,
withdraws current eligibility loss and, only after the configured terminal
retention, strips principal/session/workspace/key/credential digest/operator
metadata/callback/state/challenge and secret hashes. An opaque attempt hash,
record identity, version/purpose/status and timestamps remain as a tombstone to
refuse reuse. Live issued tickets are not privacy-pruned. Total-row capacity
counts tombstones, bounding this fixture rather than deleting history to make
room. No background retention worker, distributed cleanup guarantee, production
retention approval or reserved/uncertain pruning policy is implied. Mapping
revision reuse/rollback policy still needs review before real deployment.

## Validation and exact limits

- Failing-first new real route test returned404 before implementation, then the
  same prepare/decision/exchange test passed. Not a pre-existing bug claim.
- 53 selected tests across seven files pass: 18 journal/adversarial/restart,
  17 existing consent, four parser, three config, four web freshness, two return
  destination and five strict JSON. No stopped List test/review was touched.
- Four concurrent prepare requests, decisions and exchanges have one winner;
  evidence is one-process SQLite, not distributed/D1 load certification.
- Actual SQLite close/reopen with new handlers preserves issued-response-loss
  refusal and refuses old mapping against changed current config. Returning old
  config after the withdrawal does not recreate the old code. This is not a
  kill/power-loss durability test.
- Wrong verifier/tuple, browser credentials, changed mapping/principal/membership,
  and deleted session/user/workspace refuse. Journal history survives deletion.
  Exact code/ticket deadline, live-row retention and tombstone/capacity are tested.
- Strict affected server/page entry typecheck at4GiB and changed-source lint pass.
  This is not the full repository/test-graph typecheck.
- Real local Chrome signed-out login returns to the exact new page. Full key
  display, mapped decision, explicit return and real literal-loopback fixture
  callback perform one real API exchange; repeated exchange refuses. Fresh
  decline creates neither code nor ticket. Ready/return/declined pixels inspected.
  `scripts/qa/mnet-enrollment-handoff-local.ts` is the repeatable local harness.
- This callback/native-shaped consumer is a fixture, not installed native Mnet.
  No daemon state or OS integration is exercised by this new harness. Earlier
  installed native-to-preview acceptance remains its earlier exact source pair.

The first callback fixture also received an ordinary favicon request, initially
reported as a callback assertion error. The fixture now returns404 for that
unrelated request; the actual callback/exchange checks were unchanged and the
clean full journey was rerun. No product assertion or timeout was relaxed.

Next required boundaries remain authenticated registrar service design, exact
reserve/status/ack review, selected durable retention/account-event policy,
Store/daemon crash behavior, proof descriptor/adapter review and installed then
physical two-computer acceptance. No activation follows from this checkpoint.
