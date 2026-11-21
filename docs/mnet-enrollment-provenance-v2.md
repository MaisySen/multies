# Version2 enrollment provenance source checkpoint

Isolated default-off development enrollment flow. This implements the missing
SOURCE of named principal/per-handoff session evidence in the existing Multies
journal, not a registrar, native client, proof verifier, permit constructor,
node credential, network grant or connected Store transaction. Mnet3566bd85 stays
unchanged. No deploy, live account, production origin, release or spend.

## Explicit opt-in and row binding

Optional strict operator `provenance` config requires version2, exact configured
HTTPS principalAuthority origin and literal principalNamespace
`multies-local-user-v1`. Config absence preserves old behavior. No inference from
issuer label, hostname, email, OIDC subject or response content. principalId is
this authority's authenticated local users.id, NOT an external OIDC subject.
Authority and issuer-label URL bytes may match; namespace semantics distinguish
them. Wrong namespace/HTTP/path/extra fields refuse config validation.

Migration0176 adds nullable session_binding, principal_authority and
principal_namespace to EXISTING noncascading enrollment journal. Old rows retain
NULL, no backfill or synthesized read-time value. Unique session-binding index
prevents reusing a pseudonym across handoffs. NEW provenance-enabled handoff
inserts independent random256bit binding and current exact authority/namespace
in same row/eligibility statement as original user/session/launch/selected map.
Server still uses original private sessionId for eligibility, never its public
pseudonym. Two handoffs in one session get different values. User/session IDs
are not hashed into it; no dictionary oracle/salt/key lifetime. Other identifiers
still linkable, no anonymity or product retention claim.

Stored authority/namespace MUST match CURRENT explicit config before either new
response. Changing config cannot reinterpret an existing row's local principal.
Rows without all source bindings cannot produce v2 responses, including when
config is enabled after their creation. Existing v1 flow can still use its old
response, with no new provenance disclosure. Terminal PRE-reserve scrub clears
new fields alongside user/session. Reserved/uncertain/consumed evidence remains
excluded from sweep as before; no pruning/retention policy added.

## Two source responses, no native caller yet

`POST /api/mnet-enrollment-v1/exchange-v2` is a response-versioned endpoint using
existing exact native launch+code+saved-verifier request, one-shot code/ticket
semantics and original live eligibility checks. Refuses cookie/origin/ambient
Authorization and caller-added principal fields. Wrong verifier, changed authority
or missing row binding cannot consume intended owner's code. Exact success is
ONE response only, no redelivery after loss. It includes responseVersion2,
provenance {principalAuthority,principalNamespace,principalId,sessionBinding},
exact original public launch plus existing selected binding/ticket/deadlines.
No verifier/code/raw session ID/session token is echoed. Config is rechecked
around asynchronous eligibility/ticket consumption; config changes after a
one-shot operation can fail closed without secret redelivery.

`POST /api/mnet-enrollment-service-v1/reserve-evidence-v2` uses current separately
authenticated service identity, no cookies/origin, auth BEFORE parsing/lookup,
same reserve/IP/authenticated-service budgets, strict existing reserve body.
No caller-supplied principal/session/provenance. Refuses missing/old binding BEFORE
reserving. Calls actual existing immutable reserve logic, then an exact correlated
reserved-row query requires same pinned user/session/pseudonym/authority/namespace,
service/reserve/descriptor, unexpired ORIGINAL deadline and CURRENT live eligibility.
Current mapping/service/provenance and final deadline are checked again. It returns
same namespaced provenance as own PKCE, original launch/selected mapping/service,
source checkedAt, descriptor encoding version and unchanged reserve metadata.
Explicit authorityGranted:false/enrolled:false, no accessUntil or proof permit.
Exact retry may update checkedAt observation but NEVER extends reserve deadline,
changes original binding or appends another reserve event.

Existing `/exchange` response has no provenance or new launch echo. Existing
`/reserve` remains its prior shape. Historical `/status` and `/ack` remain
historical, no provenance/checkedAt/live-authority fields. After session/member
withdrawal live reserve evidence refuses while exact same-service historical
status remains readable under existing rules. Late receipt is still history.
New source response is not native transport/bootstrap authentication and does
not validate WireGuard possession or grant node/network access.

## Validation and corrections during development

New source tests exercise own-PKCE versus live-service same-row equality,
non-bearer random session-binding privacy, no raw session/token echo, immutable
retry/deadline/event, old-row refusal, config/authority/binding/session/service/
deadline changes, strict caller-field/auth rejection, distinct same-session
handoffs/terminal scrub, wrong verifier and one-shot retry, actual SQLite
backup/close/reopen, migration NULL preservation and explicit config syntax.
Isolated local Miniflare/workerd D1 applies0173through0176 and runs ACTUAL source
reserve-evidence SQL with minimal explicit eligibility tables, retry and deleted
session refusal. Not full app/deployed D1 acceptance.

Initial development regression run exposed an accidentally inserted response-
version guard in decision, which was removed before final validation; a subsequent
run exposed old D1/migration tests selecting today's schema after only old
migrations. D1 fixture now includes0176, historical0175 test uses explicit old
columns, preserving its migration/rebuild assertions. No historical migration
source changed, especially0073. This is not a claim of failing-first TDD for the
new source response, whose tests were written during implementation.

Affected server-entry strict TypeScript4GiB and changed-file ESLint pass. Full
application/testgraph typecheck is NOT claimed. Exact affected suite result/log
is retained in review packet. No browser/native/UI changes so no pixel or
installed journey claim. Existing raw570byte reserve vector remains unchanged;
new session pseudonym/authority does not silently enter reserve-v1 hash. Future
v4 proof binds these values additionally and native must compare them against its
own code-bound source response before any WireGuard-key use.

## Remaining connected engineering

No Mnet/native service client consumes these responses yet. Need reviewed strict
response parser/ownPKCE pending intent and current config, named bearer/TLS
terminator boundary or versioned alternative, owned challenge/admission, reviewed
DH/MAC verifier/server confirmation, private authenticated permit and real
atomic consumed-proof/node/receipt/claim persistence with capacity/time/race/
restart fault evidence. HTTP endpoints returning source evidence are not a
callable Store authority path. Shared strict v4 codec/protocol review remains
separate from this evidence source.

Source checkedAt plus current query cannot make Multies and Store atomic. No
immediate upstream revocation, maximum accepted clock skew, product lease/access
duration/retention/renewal or recovery epoch selected. Full unmodified D1 chain
still fails historical0073 under earlier emulator checks; this selected-slice
SQL evidence does not close it. Native Windows/macOS, daemon durable save,
already-distributed direct mesh, physical separate-device and rollback gates
remain. Work stays isolated/off and no activation permission is inferred.

Final exact-source affected suite:83tests6files PASS, including17new provenance
source tests and the selected local D1 path; strict affected-entry typecheck and
changed-file lint pass. Both temporary dependency symlink and one-off typecheck
config removed before commit. No dependency installation or lockfile change.
