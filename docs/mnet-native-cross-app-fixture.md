# Actual Multies handler/SQLite to native own-PKCE fixture

Explicit opt-in cross-repository acceptance harness. No production code changes, native trigger, live account, deployed source or real service credentials. Go test is build-tagged multies_native_fixture; Multies test skips without MNET_NATIVE_REPO. All resources and any generated credential material are disposable local test fixtures, deleted after each case. No secret is printed or retained in review logs.

## Run

In the corresponding Multies repository, with its normal test dependencies installed:

    MNET_NATIVE_REPO=/absolute/path/to/Mnet node_modules/.bin/vitest run tests/mnet-native-cross-app.test.ts

The coordinator needs Go, OpenSSL, Node and normal Multies native SQLite test dependencies. It generates a disposable local certificate with literal IPv4 SAN. Go uses normal verified TLS with that cert in test-process roots, not InsecureSkipVerify or a custom transport. No internet listener: TLS and callback bind 127.0.0.1 only.

## Actual exercised boundary

Multies existing setup fixture creates its real app/SQLite/person/session/operator config. Native expected mapping, local principal list and service are taken from independently supplied fixture operator config BEFORE source response, not inferred from returned exchange identity. Native daemon acquires actual State owner, prepares durable key, reads installed fixture policy, saves fresh intent and owns callback socket. Private temp IPC carries only fixture config/public launch/nonsecret outcome and a continuation signal, not native secrets.

Coordinator calls actual authenticated Multies prepare/decision handlers with the native launch and follows the exact actual decision redirect into the native loopback socket. This is a programmatic HTTP redirect, not a browser or human consent UI test. Native then explicitly invokes its private one-shot exchange composition over verified local TLS. The bridge forwards the exact body/headers into the actual exchange-v2 app handler (host set to the fixture app's allowed localhost). It does not construct source response objects. Actual source handler performs PKCE validation and conditional SQLite transition. No Store/registrar consumer participates.

Successful response is parsed/persisted by native. Coordinator verifies native saved launch/source provenance matches SAME source row including local user ID, opaque session binding, principal authority, workspace and network. Native checks original/current allowed policy and actual owned key/State. Native tests assert unchanged State bytes and absent node credentials/client/device.

## Cases

* Success: one source send, source row issued, native exchanged-data.
* Decline: actual source declined, actual native declined-data, ZERO source exchange sends.
* Membership revoked after approved callback: actual source handler refuses403 and row withdrawn, native durable exchange-may-have-started/remote-unknown. No automatic retry/reconsent.
* Lost response: bridge destroys response only AFTER actual source handler commits issued ticket. Actual source row issued but native durable remote-unknown; second explicit call cannot replay admitted one-shot exchange.

All cases use actual native race-instrumented Go child tests, not synthetic source responses. Normal tagged Go tests without coordinator skip safely. Combined Multies evidence: 90 tests across seven files passed. A separate targeted tsc graph invocation with4GiB heap was OS-killed exit137, so no new TypeScript typecheck acceptance is claimed. The earlier packet did not retain the exact attempted command/config and failure output, despite previously claiming it did. That historical log cannot be reconstructed as evidence. Independent review separately reproduced exit137; neither run establishes typecheck acceptance. Existing source fixture type evidence does not close this new harness graph gap.

## Limits

This closes only the local programmatic consent-to-own-PKCE DATA integration. It is not browser/UI visual acceptance, actual user approval, authenticated registrar reservation/bootstrap/possession proof, Store consumption, native credential-finalization or enrolled network. The SQLite fixture is not full D1 migration/runtime acceptance; the previously unresolved full D1 chain is unchanged. No policy installer, production source address/service identity, lease policy or real account was selected. Native Windows/macOS/mobile execution, downgrade discipline, persistent recovery and physical two-host acceptance remain separate.

## Actual Store-owned service-reserve extension

The success case now continues after native own-PKCE DATA through a second tagged Go participant in actual control Store. Coordinator supplies independent fixture service scope/secret/maps/budgets, and the source request carries the ticket/launch/mapping saved by the completed native exchange. Service allowed mapping is built independently from original operator config, never derived as trusted policy from the response. The actual retained Store owner parses its fixed config and invokes its private bounded source client over the same verified local TLS bridge.

Bridge forwards service Authorization/body to the actual authenticated reserve-evidence-v2 app handler. Real SQLite source row transitions issued to reserved. Native-side parser independently compares service reserve DATA against the earlier native own-PKCE observation, exact request descriptor and allowed tuple. Coordinator checks same original sessionBinding/local principal/descriptor/reserve identity. One actual service send; second explicit request is locally refused by spent-attempt admission. Store bytes/node/registrar records and native State remain untouched. This is reservation DATA, not an eligibility lease, verified commit permit, challenge, consumed proof, network enrollment or credential finalization. Decline/revoked/lost-own-PKCE cases still never reach a service-reserve invocation. Default-off invocation and earlier TypeScript exit137 limitation remain unchanged.
