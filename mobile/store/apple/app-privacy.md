# Multies: App Privacy answers (App Store Connect)

Must match the privacy manifest (`ios.privacyManifests` in app.json, copy in store/ios/PrivacyInfo.xcprivacy), store/privacy-policy.md and the code. Change all four together.

Privacy policy URL: https://multies.si/privacy/

Tracking: No. No ads, no analytics or advertising SDK, no data brokers.

| Data type | Collected | Linked to the user | Tracking | Purpose |
| --- | --- | --- | --- | --- |
| Contact Info: Name | Yes | Yes | No | App Functionality |
| Contact Info: Email Address | Yes | Yes | No | App Functionality |
| User Content: Emails or Text Messages (mail and team chat) | Yes | Yes | No | App Functionality |
| User Content: Other User Content (tasks, comments, docs, time entries, files attached in chat) | Yes | Yes | No | App Functionality |
| Identifiers: User ID | Yes | Yes | No | App Functionality |
| Identifiers: Device ID (push token, only after the person allows notifications and push is on) | Yes | Yes | No | App Functionality |
| Diagnostics: Other Diagnostic Data (server request logs, device type per session, error reports with account ids, no message content) | Yes | Yes | No | App Functionality |
| Location, Contacts, Health, Financial Info, Browsing History, Search History, Purchases, Photos or Videos, Audio, Usage Data, Sensitive Info | No | | | |

Notes
- Linked is declared for everything stored against the account, Diagnostics included, because the privacy policy says error reports carry account ids (playbook 3.6: over declaring is not rejected; under declaring is). Changed 25 Oct 2026 from Linked: No.
- Files a person attaches in chat come from the system file picker (expo-document-picker), not the photo library, and the app has no camera or photo library permission, so they count as Other User Content and Photos or Videos stays unselected. If Apple Review disagrees, add Photos or Videos with the same answers as Other User Content.
- The push token is declared even though builds without an Expo project id fetch none.
- Required reason APIs declared in the manifest: UserDefaults CA92.1, FileTimestamp C617.1 and 0A2A.1, SystemBootTime 35F9.1, DiskSpace E174.1 (from the Expo and React Native modules in the app; a unit test checks them against node_modules).
