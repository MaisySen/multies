# Release verification

Update [the handover](release-handover.md) after a milestone changes. Record what was observed, where (local, protected staging or live) and what remains. A tested patch, queued build and verified delivery are different states.

## Console / Workspaces

1. Pin the tested source and isolated package. Confirm the recovery checkpoint can be restored without applying it to production.
2. On protected staging, use the intended ordinary account. Record its prior role, the scoped transition, independent revocation and denial of the old sessions. A different sample does not establish this gate.
3. Verify cleanup before touching production. Stage and release checks must not modify inbound Mail or the shared stage. After release, check the exact live version and monitor it using its own release filter.

## Native releases

1. Include app icons, splash and other required assets in the actual source archive. Exclude signing material and environment files. Run typecheck, tests, native prebuild and bundling on the exact candidate.
2. Compare iOS update fingerprints on the submitted and build-host inputs. Keep the existing update channel and runtime policy. Use a normal dependency layout inside the project so paths do not differ between build hosts.
3. For App Store Connect, use Xcode 26 or later and iOS SDK 26 or later. Verify the actual SDK, app identity, Store provisioning, main app signature, update channel and runtime in the signed output. Submission to a test track and installation on the test device are separate checkpoints. Record each separately.
4. Match the update to the installed test build’s embedded runtime and channel. Do not use OTA to introduce or change app features or bypass App Review; put feature and native changes through a new signed build and review.

## Wallet and integrations

Verify the protected runtime’s least-privilege database account before allowing writes. Prove a synthetic refresh on the physical device. Verify integration discovery and consent in the actual approved clients, rather than inferring acceptance from a unit test.

Keep credentials, account identifiers, private endpoints, session contents, customer information and signed artifact links out of these documents.
