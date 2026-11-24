# TikTok posting (internal)

Round 83 added our own TikTok sign in and Direct Post (`src/server/services/direct-social`). The owner
approved the production TikTok app in November 2026, so production now runs with
`TIKTOK_MODE = "production"` in `wrangler.toml` (pinned by `tests/direct-social-r83.test.ts`).

| Setting | Where | Effect |
| --- | --- | --- |
| `TIKTOK_MODE` | Worker var | `production` uses only `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET`; `sandbox` only the sandbox pair. Unset prefers the production pair and accepts webhooks signed by either app. |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | Worker secrets | The production app. With the mode set to `production` and either one missing, TikTok shows as unavailable and sign in answers 503. |
| `TIKTOK_SANDBOX_CLIENT_KEY`, `TIKTOK_SANDBOX_CLIENT_SECRET` | Worker secrets | The sandbox app (test accounts only). |
| `TIKTOK_SCOPES` | Worker var | The scopes the app has. Production and staging ask for `user.info.basic,video.upload,video.publish`. |

Before deploying a change to the mode, check the secrets are there: `npx wrangler secret list` (and
`--env staging`). Staging leaves the mode unset. Accounts connected through the sandbox app stop
working once production switches apps, and their owners connect TikTok again.

The webhook (`/api/connections/webhooks/tiktok`) must be registered in the production app's portal
with the same address; with a mode set, only that app's secret verifies the signature.
