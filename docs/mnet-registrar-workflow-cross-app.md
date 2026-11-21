# Real source-to-registrar development fixture

New opt-in `tests/mnet-registrar-workflow-cross-app.test.ts` runs the actual Multies person approval, own-PKCE-v2 exchange, service authentication, reserve-evidence-v2 handler and SQLite row, through verified local HTTPS, into Mnet's private development registrar workflow. No Multies production source, route, migration, runtime feature configuration or deployment is changed by this batch.

Two independently approved disposable device keys create two actual Mnet Store nodes/receipts/consumed-proof claims atomically. Each current credential's actual map contains the other peer. Delete removes current access and peer delivery but preserves immutable receipt/claim history. The fixture ends with both nodes deleted. A second case removes real membership immediately before reserve and asserts actual 403 with zero Mnet node.

The source row remains `reserved`, has one actual reserve event and no receipt acknowledgement. No fake ack or `enrolled:true` is written. Multies reserve still returns `authorityGranted:false` and no access-until. Mnet independently configured development policy supplies a finite initial lease, bounded by its proof/observation limits and source reserve deadline. These explicit TEST values are not production duration, renewal, revocation guarantees or user-account effects.

Native-side key/secret/PKCE values are disposable test-owned values with private presave/attempt markers, not an actual daemon key caller or native State installation. Verified source transports are real, while private Mnet begin/submit calls are direct in the fixture, not production registrar ingress. Actual peer-map delivery is not physical WireGuard, desktop, pointer or Shared Desk acceptance. No screen/input authority follows.

With dependencies already installed, run from this Multies checkout:

```
MNET_NATIVE_REPO=/tmp/mnet-multies-client ./node_modules/.bin/vitest run tests/mnet-registrar-workflow-cross-app.test.ts --maxWorkers=1
```

Use the actual Mnet checkout path. Without the explicit repo parameter the test is skipped. It starts only disposable loopback TLS, generates its own fresh local certificate with openssl, uses normal Go verification with isolated test roots, and invokes Go's tagged fixture participant under `-race`. Unlike the separate httptest unit fixtures, this cross-repo certificate really is generated for that test run. It creates no live user, service credential, installed device, deployment or lasting remote process. Private fixture directories and test DBs are closed/removed.

Initial new command attempted npx with missing worktree dependencies and failed before loading the tests; dependencies were then linked from the existing local integration checkout. The actual passing run used the explicit local Vitest binary above, not a newly downloaded version. New test passes runtime assertions and ESLint after correcting an empty polling catch. No new full-graph TypeScript typecheck acceptance is claimed.

The Mnet implementation's complete authority, publication/race/failure semantics and remaining native transport/finalization gaps are documented in its `docs/enrollment-connected-development-workflow.md`. Multies source/provenance semantics are unchanged. Full D1 migration/runtime and activation remain separate from actual local SQLite acceptance.
