# Security: keys and secrets for the mobile app

Nothing secret lives in this repo. `.gitignore` blocks `*.jks`, `*.keystore`, `*.p8`, `*.p12`,
`*.mobileprovision`, `secrets/`, `credentials.json` and `.env*.local`.

| Secret | Where it lives | Never in |
| --- | --- | --- |
| Android upload keystore (alias `upload`, Fintex) | `~/.multies-secrets/multies-upload.jks` on the build box (mode 600), the password in `~/.multies-secrets/android-keystore.json`, the credentials email to the owner | repo, chat, docs |
| Gradle signing values | `~/.gradle/gradle.properties` on the build box (`MYMAIL_UPLOAD_*`) | repo |
| App Store Connect API key (.p8) | `~/.multies-secrets/` on the build box (mode 600) and GitHub repository secret `ASC_KEY_P8` | repo, chat, docs |
| Retired round 9 keystore (`mymail-upload`, never uploaded to Play) | kept in the credentials email, marked retired | repo |

Public values that are fine in the repo: the Auth0 native client id (a public PKCE client), the
API base URL, the Apple team id, the Key ID and the Issuer ID.

Before any repo is made public: `git log -p | grep -iE "BEGIN (EC|RSA)? ?PRIVATE KEY|password=|secret="`
must print nothing, and check every commit, not only the last one.

Every credential that is created or changed goes into the full credentials list emailed to the
owner (playbook rule 3).

Reporting a security issue: contact@fintex.au.
