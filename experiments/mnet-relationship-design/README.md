# Isolated relationship eligibility and event DATA model

Implementation candidate for design review only. Default-off by having no live
importer or registration. No environment gate can turn it on. New files live
outside src; the only importing code is the explicit test. No persistence,
schema/table, endpoint, credential/token, expiry, carrier, clock or duration.
No network grant, peer installation or withdrawal hook is implemented.

This pure predicate evaluates supplied facts about a proposed own-user ongoing
networking approval. Positive output means eligible for further evaluation DATA,
never authority. Every result has authorityGranted:false, no opaque capability,
secret, key, grant ID, deadline or side effect. Inputs are not authenticated by
this model. An attacker who constructs true facts can produce eligible DATA;
that is not an access bypass because no live path consumes the result.

Requirements represented explicitly:

- Actual explicit approval must be authenticated, same user, not impersonated.
  Current workspace owner status cannot bypass those checks. No admin can approve
  a different user's relationship through this model.
- Approval-time login method is distinct from current SSO policy and current
  role. Non-owner password approval fails current SSO; owner break-glass matches
  the existing account rule, not a newly added operator exception.
- Current user, human membership and workspace eligibility must hold. Suspension
  is a derived evaluation result only, not stored lifecycle state.
- Security events must be explicitly evaluated by a future authoritative source;
  password change/reset, session/credential compromise and security revoke require
  withdrawal, new approval generation and changed security generation. This code
  does not implement or claim any existing hooks do that.
- Own-user revoke requires an authenticated non-impersonated actor but deliberately
  not workspace eligibility. There is no owner/admin cross-member revoke power.
- Source unavailable prevents new evaluation without manufacturing revocation.
  Eligibility restored requests recheck only, not a new approval or state write.
- Withdrawal/generation mismatch cannot be undone merely by eligibility becoming
  true. A positive new evaluation requires independently supplied explicit new
  approval/security facts. Equal local generations are not monotonic/antirollback
  proof; no independent authority or storage is created by these strings.
- Browser logout no-change is the explicitly proposed logout-independent model,
  not current behavior or approved recurring permission. Browser-present/current
  session-bound mode remains the alternative and the existing runtime remains it.
  Local Disconnect/startup controls classify requirements only. A withdrawal result
  asks future orchestration to stop, does not mean traffic already stopped.

The original device credential still inner-joins its live source session; existing
password/session/removal security is unchanged. A future sessionless implementation
would need actual event hooks and authoritative generations before wiring this
predicate. Account-specific operator/owner/device-user approval remains closed.

## Evidence

26 focused model tests pass, including unknown/untyped facts, impersonation,
cross-user/admin rejection, SSO, security generations, withdrawal nonresurrection,
own-user revoke, exact output keys, input immutability and no imports/live importer.
One grouped run passed60 tests across the model, unchanged device bridge and
unchanged joining consent suites. The original bridge tests include revoked
session/membership/SSO/impersonation/default-off/current-session rejection, so this
is actual unchanged-path regression, not a replacement simulation.
Scoped strict TypeScript check and new-file ESLint pass. No full app/release build
or real accounts were run. Existing service/auth/role/SSO sources and original
bridge test are byte-identical to accepted baseline8b9296f. No equivalent peer
expiry or admission fault suite was repeated for this pure model.

Run from Multies source with existing dependencies:

    node node_modules/vitest/vitest.mjs run tests/mnet-relationship-design.test.ts
    node node_modules/vitest/vitest.mjs run tests/mnet-relationship-design.test.ts tests/mnet-device-bridge.test.ts tests/mnet-enrollment-consent.test.ts
    node node_modules/typescript/bin/tsc -p experiments/mnet-relationship-design/tsconfig.json
    node node_modules/eslint/bin/eslint.js experiments/mnet-relationship-design/model.ts tests/mnet-relationship-design.test.ts

Independent review is required before any wiring. This packet proposes no wiring.
