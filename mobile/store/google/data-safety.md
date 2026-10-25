# Multies: Google Play Data safety answers

Must match store/privacy-policy.md, store/apple/app-privacy.md and the code. Update the same day a feature changes what is collected (including OTA updates).

| Question | Answer |
| --- | --- |
| Does the app collect or share any required user data types? | Yes |
| Is all user data encrypted in transit? | Yes (HTTPS only) |
| Can users request that their data is deleted? | Yes: in the app (Settings, Delete my account) and at https://multies.si/delete-account/ |

| Data type | Collected | Shared | Ephemeral | Required or optional | Purposes |
| --- | --- | --- | --- | --- | --- |
| Personal info: Name | Yes | No | No | Required | App functionality, Account management |
| Personal info: Email address | Yes | No | No | Required | App functionality, Account management |
| Personal info: User IDs | Yes | No | No | Required | App functionality, Account management |
| Messages: Emails | Yes | No | No | Required | App functionality |
| Messages: Other in-app messages (team chat, task comments) | Yes | No | No | Optional | App functionality |
| Files and docs: Files and docs (attachments a person adds to chat messages and emails) | Yes | No | No | Optional | App functionality |
| App info and performance: Diagnostics (server request logs, device type per session, error reports with account ids, no message content) | Yes | No | No | Required | App functionality, Fraud prevention, security, and compliance |
| Device or other IDs (push token) | Yes | No | No | Optional (only after the person allows notifications) | App functionality |
| Location (approximate and precise), financial info, health and fitness, photos and videos, audio, calendar, contacts, app activity, web browsing, crash logs | No | | | | |

Files and docs is Yes because chat has a file picker (src/lib/chat-files.ts, up to 5 files of 10 MB per message). Crash logs is No because the app has no crash reporting library; error reports come from the server and are counted under Diagnostics.

Not shared: mail goes to the recipients a person addresses (user initiated). Cloudflare, Resend, Auth0, Sentry, Stripe and Expo process data for Fintex as service providers, which Play does not count as sharing.

## As entered in Play Console (25 Oct 2026)

- Account creation methods: username and password, and OAuth (Google, Apple and GitHub through the Multies sign in page).
- Delete account URL: https://multies.si/delete-account/
- Delete data URL (Play asks for it separately; there is no separate page yet): https://multies.si/privacy/ (the privacy policy, which explains how to delete data without deleting the account). Point it at a dedicated page if one is published.
- Can users request that some data is deleted without deleting the account? Yes (workspace owners can export and delete mail in the web app).
- Content rating: the IARC questionnaire came out 12+ (Play shows it because the app lets users exchange mail and chat), not the Everyone expected in content-rating.md. See that file.
- Saved in Play Console; not yet sent to Google for review.
