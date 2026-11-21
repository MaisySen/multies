# Separate Mnet computer joining consent

Local branch `mnet-enrollment-consent`, based on validated List snapshot
d7dafd98815e64a36e5263125e3fc25d0c56c26b. Nothing deployed. The previous worktree
and its stopped/unverified lifecycle test edit are untouched and excluded.

## Implemented boundary

The separate `/mnet/enroll` browser screen and `/api/mnet-enrollment` handlers
record an enrollment-only pending/approved/declined decision. They do not issue
a ticket, assertion, credential or proof, consume a registrar challenge, create
a network node or start networking. `/token`, `/consume` and `/recover` do not
exist. A decision has no production consumer. The result explicitly says the
registrar is not connected and the computer has not joined. Screen/keyboard/
mouse permissions remain separate and false.

The feature is off by default. To run a disposable local fixture, both
`MNET_ENROLLMENT_CONSENT=on` and explicit `MNET_ENROLLMENT_OPERATOR` configuration
are required. Missing operator config returns404, not a guessed origin or
inferred whole-workspace enrollment. Invalid explicit config refuses startup.
No production config has been selected or written.

Operator configuration shape for this Multies-side branch:

```
{
  "revision": "fixture-r1",
  "issuer": "https://issuer.example.test/path",
  "registrarOrigin": "https://registrar.example.test",
  "audience": "fixture-enrollment",
  "bindings": [{
    "workspaceId": "existing-fixture-workspace-id",
    "networkId": "existing-fixture-network-id",
    "principals": ["immutable-local-user-id"]
  }]
}
```

The issuer and origin are exact configured strings, not resolved/normalized
identities. The issuer namespace currently identifies local immutable Multies
user IDs. This is an explicit-principal minimal implementation, not an implicit
policy that all members or email matches may enroll. No service identity or
assertion verifier is installed. It must be reconciled with the Mnet-side
operator handoff at the later service integration boundary; this branch schema
is not silently accepted as Mnet's differently named offline JSON format.

## Request and decision

The launch query has exact `attemptId`, `devicePublicKey` and `platform` fields.
The key is the full canonical32byte base64url public key, not a thumbprint or
proof of possession. Requests cannot choose a registrar, issuer, audience,
network or revision. Workspaces must already exist, be in the operator mapping,
allow the exact immutable local user, and pass the existing live eligibility
checks. Network existence must still be verified by the unimplemented registrar.

Preparing a request stores its exact person/session, workspace/key/attempt and
operator tuple in a new purpose-specific table. Duplicate attempt IDs refuse;
there is no timeout-reset or cleanup-based reuse. Current live eligibility is
correlated into the same INSERT. The two-minute decision lifetime and20current
request ceiling are local development limits, not selected production policy.
No broad Multies cookie or List bearer is exchanged for node authority.

Only the same current person/session can decide a still-pending unexpired row.
Current mapping, allowlist and live eligibility must still match. Conditional
UPDATE gives competing decisions one winner. Audit rows contain action and
opaque record ID, not a public key, token or full tuple. No new membership,
workspace, role or principal provenance is created by this flow.

Session deletion cascades these unredeemable browser decisions. Tests initially
expected a pending row after auth cleanup of an expired session; the actual auth
layer deletes that expired session, cascading the row. The test now requires
absence for that case and no approval. This is not a durable registrar receipt
or tombstone design and must not become one by adding a redeem route.

## Evidence and limits

Selected34tests across7files pass: enrollment consent/config, strict JSON,
post-login destination, fresh browser reads, auth and SSO. Enrollment cases cover
default-off/config-missing, mapped approval, repeat/duplicate refusal, mapping/
membership/session/expiry/other-person change, ambiguous JSON, non-allowlisted
principal, same-person second-session refusal and competing allow/decline.
List-shaped bearer cannot authorize a browser enrollment request.

Changed-source lint passes. Strict server and combined server/page entry checks
pass with a4GiB Node heap. The first combined check hit the default1GiB heap
ceiling and was not a pass. This is not a full-repository/test-graph typecheck;
that earlier limit remains separately recorded. The stopped List test was not
read or executed.

Actual disposable Chrome with the real app handlers and Vite-rendered page
performs explicit mapped approval and decline. Desktop and390pixel phone
screens and the truthful not-enrolled result were inspected. A first rendering
fixture omitted the symlinked dependency directory from Vite's allowed font
paths; the corrected fixture loads the actual fonts and passes again. No user
browser profile, real account or production endpoint was used. This is not
native-to-registrar, physical pairing or completed consumer setup acceptance.

## Required next work

Have the isolated diff reviewed before extending it into service authority.
Implement and review authenticated enrollment assertion/ticket semantics,
independent expected-binding construction, atomic durable node/authority commit,
crash/recovery state and integrated revoke/tombstone handling. Do not attach the
inactive key experiment or legacy Join/ApproveNode as a shortcut. No activation,
release, default production origin, global logout behavior, recovery window or
revocation SLA follows from this branch-only consent checkpoint.

## Displayed mapping guard and review reconciliation

A later route regression proved that changing the configured network after the
browser preview but before prepare could record an unseen newer mapping. The
old request returned201 in that failing-first case. Prepare now requires the
exact displayed issuer/registrar/audience/revision/network tuple and compares it
against independently resolved server config. The browser tuple is a comparison
guard, never permission or configuration. All five altered fields refuse403
before writes; the ordinary real browser approval/decline journey still passes.
An initial test used the proposed new field against the old strict schema and
received400; the decisive reproduction used the actual old browser shape and
observed201, separately retained in the local test log.

Duplicate prepare now has explicit `ON CONFLICT(attempt_id) DO NOTHING`, followed
by the existing controlled refusal. Four concurrent in-process real handler
requests yield one201 and three403, one stored row. This is not a distributed
multi-writer/D1 load test or a claim that every database error maps to403.

Session-expiry refusal tests permit either a still-pending row or cleanup-driven
absence. Safety depends on live auth/eligibility and conditional decision checks,
not on when cleanup runs. Approved/expired/declined rows remain session-scoped,
unredeemable browser decisions and cannot be durable registrar receipts.
Production retention of public keys/attempt tombstones needs explicit policy;
indefinite retention to prevent ID reuse is not silently a product choice. Do
not add a pruning job or redemption route until durable records and privacy
retention are designed together. The source-only consent review did not exercise
base CSRF/rate-limit/audit internals, multiwriter prepare or end-to-end enrollment.

After this change,23focused enrollment/config/freshness tests pass, changed lint
and combined server/page strict entry typecheck pass, and actual font-loaded
browser approval/decline is rerun with inspected ready/not-enrolled pixels. The
earlier34test broader checkpoint remains its own source checkpoint, not a new
full-suite claim for this small guard change.

## Provisional handoff parser preparation

`mnet-enrollment-handoff-shape.ts` is an unrouted parser for the unaffected
version/purpose/native callback/PKCE core only. It is imported by no production
module. Its distinct fixed `/mnet/enrollment/callback` path cannot be used by
the current List handoff. Four focused tests cover exact fields, purpose/version,
omissions, callback aliases/port boundaries, canonical digest/verifier shape,
strict decoded duplicates and rejection by both current List and preview schemas.
Changed-source lint passes. This is not PKCE exchange implementation, proof of
key possession, ticket issuance or enrollment. Credential/recovery-dependent
fields and durable journal schema remain provisional pending the focused design
review, rather than being frozen by this parser preparation.
