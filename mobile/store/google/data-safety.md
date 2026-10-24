# Multies: Google Play Data safety answers

Must match store/privacy-policy.md, store/apple/app-privacy.md and the code. Update the same day a feature changes what is collected (including OTA updates).

| Question | Answer |
| --- | --- |
| Does the app collect or share any required user data types? | Yes |
| Is all user data encrypted in transit? | Yes (HTTPS only) |
| Can users request that their data is deleted? | Yes: in the app (Settings, Delete my account) and at https://multies.sites.tab.bot/delete-account/ |

| Data type | Collected | Shared | Ephemeral | Required or optional | Purposes |
| --- | --- | --- | --- | --- | --- |
| Personal info: Name | Yes | No | No | Required | App functionality, Account management |
| Personal info: Email address | Yes | No | No | Required | App functionality, Account management |
| Personal info: User IDs | Yes | No | No | Required | App functionality |
| Messages: Emails | Yes | No | No | Required | App functionality |
| Messages: Other in-app messages (team chat, task comments) | Yes | No | No | Optional | App functionality |
| App info and performance: Crash logs or Diagnostics (server error reports) | Yes | No | No | Required | App functionality |
| Device or other IDs (push token) | Yes | No | No | Optional (only when notifications are allowed) | App functionality |
| Location, financial info, health, photos and videos, audio, files and docs, calendar, contacts, web browsing, app activity | No | | | | |

Not shared: mail goes to the recipients a person addresses (user initiated). Cloudflare, Resend, Auth0, Sentry and Expo process data for Fintex as service providers, which Play does not count as sharing.
