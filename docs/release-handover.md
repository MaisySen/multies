# Release handover

Updated 22 November 2026 (AEDT). This page distinguishes source checks, staging, signed builds and delivery. A failed or queued job does not constitute a release.

| Area | Verified so far | Still required |
| --- | --- | --- |
| Console / Workspaces | Combined candidate: 48 local browser tests passed; two screenshot-only tests intentionally skipped. Isolated Worker dry-run passed. The production recovery checkpoint was independently restored. No release from these checks. | Verify the protected ordinary-account role lifecycle, then deploy that exact candidate via the isolated release path and check the live release. |
| iPhone Mail | Message-open fix exercised offline. | Reproduce the intended behaviour in the installed iPhone build. |
| Android Devices | Verified unsigned candidate. | Sign with the authorised Android identity, install and verify the actual Devices flow. |
| Stampies iOS | Native icon and splash restored. iOS prebuild, bundle and 118 app tests passed. The Mac accepted signing preparation and installed pods. A runtime mismatch was traced to dependency paths; the corrected layout reproduces the exact Mac fingerprint. | Verify a signed archive matching the corrected runtime. Upload and installed TestFlight behaviour are separate gates. No TestFlight upload yet. |
| Apple Wallet | Synthetic pass proof and refresh implementation reviewed. The prospective deployment is not live. | Verify a least-privilege runtime, then prove an actual pass refresh on an iPhone. |
| Mnet | Build and signing work in progress; no new signed release claimed. | Verify standalone iOS archive and internal installation; qualify other platforms separately. |
| MCP | Discovery changes tested offline. | Confirm authenticated discovery in both actual client applications. |
| TikTok | Approval and exact production scope not verified. | Verify the existing app and consent, denial and disconnect in the approved sandbox. |
| Release infrastructure | Staging boundary unchanged. Production rollout and repository visibility are unchanged. | Verify the isolated live release and the required workflows before changing visibility. |

See [release verification](release-verification.md) for the acceptance sequence. Maintain this page as the per-lane status, not as a place to store access or account details.
