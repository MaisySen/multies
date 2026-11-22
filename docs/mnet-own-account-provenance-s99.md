# S99 summary-only provenance configuration, source only

This adds explicit independent loader wiring for the development own-account display route. It does not enable joining, install a native profile, confirm an account or change source authority into a native pin.

## Default and explicit input

With no MNET_OWN_ACCOUNT_PROVENANCE input the new property is absent and the summary route remains unavailable. There is no APP_URL, bridge-origin, identity-provider or enrollment-operator fallback.

The only accepted JSON shape is:

```json
{"version":1,"purpose":"mnet-own-account-summary","principalAuthority":"https://identity.example.invalid","principalNamespace":"multies-local-user-v1"}
```

The input must be at most4096 UTF8 bytes. Version/purpose/namespace and every field are required; extra fields, duplicate decoded keys/escaped aliases, nonobjects, trailing content, missing/invalid authority and enrollment-shaped wrappers refuse. The authority is an explicit HTTPS origin without credentials, path, query or fragment, bounded to2048 UTF8 bytes with no control/format/surrogate/replacement characters. It is syntax-checked source display provenance, not proof that a native installed profile accepts it.

Supplying this input requires development mode, MNET_DEVICE_BRIDGE=on, and both MNET_ENROLLMENT_CONSENT and MNET_ENROLLMENT_HANDOFF off. Invalid input or incompatible gates fail loadConfig; the input is not silently ignored. Absence leaves existing unrelated configuration behavior unchanged. An empty input is malformed, not an implicit default.

The runtime route independently revalidates the dedicated property and the same gates. It no longer reads mnetEnrollmentOperator. The existing enrollment operator parser/loading conditions, enrollment/service/handoff default flags, List service and DB schema are unchanged. The summary property carries no workspace/network/principal mapping or permission.

## Connected source tests and compile boundary

The six existing real-route protocol cases now obtain provenance through makeTestApp -> actual loadConfig, not a manually injected operator. Setup asserts both enrollment flags false and no enrollment operator. The valid summary case also asserts consent/handoff routes404. The absent case uses the actual loader with no provenance, verifies summary404 and old empty-key List200.

The malformed case also passes actual loadConfig as the configuration argument on the real createApp path and expects refusal before a route table is constructed, reusing the existing test databases. Four additional configuration cases cover absent/default origin independence, valid explicit input with enrollment defaults unchanged, malformed/ambiguous/enrollment-shaped input rejected before route construction, and incompatible development/bridge/enrollment gates rejected.

This candidate is source/compile only. No S99 Vitest, artifact export, account flow or deployment has run. Earlier S98b results remain scoped to their own reviewed trees. The previous S98a five-pass/one-fail and full-graph compiler137 histories are not changed.
