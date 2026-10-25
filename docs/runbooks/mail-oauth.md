# Sign in with Google or Microsoft for connected mailboxes (owner steps)

Built in round 18 and switched off. Connected mailboxes work today with an app password over IMAP and SMTP. These steps turn on the "Sign in with Google" and "Sign in with Microsoft" buttons on the connect form. Each needs the owner, because the provider reviews the company, not the code.

The code: src/server/services/connect/oauth.ts (authorization code flow with PKCE, XOAUTH2 for IMAP and SMTP, refresh tokens stored encrypted like app passwords). Tests: tests/connect-units.test.ts.

## Switches

Set as Worker secrets on production (and staging if wanted), then deploy:

| Variable | Value |
| --- | --- |
| MAIL_OAUTH | on |
| GOOGLE_MAIL_CLIENT_ID, GOOGLE_MAIL_CLIENT_SECRET | from step 1 |
| MICROSOFT_MAIL_CLIENT_ID, MICROSOFT_MAIL_CLIENT_SECRET | from step 2 |
| MICROSOFT_MAIL_TENANT | common (default; personal and work accounts) |

Without MAIL_OAUTH=on, or without a provider's id and secret, that provider's button stays hidden and its start link answers 404.

## 1. Google (Gmail and Google Workspace)

1. Google Cloud console, project for Multies (Fintex Australia Pty Ltd as the organisation).
2. APIs and services, OAuth consent screen: External, app name Multies, support email, logo, home page https://multies.si, privacy policy https://multies.si/privacy, terms https://multies.si/terms. Authorised domain multies.si (already verified in Search Console).
3. Scopes: openid, email, and https://mail.google.com/ (full IMAP and SMTP access). This is a restricted scope.
4. Credentials, OAuth client ID, Web application. Redirect URI: https://multies.si/api/connections/oauth/google/callback (add https://preview.multies.si/api/connections/oauth/google/callback for staging).
5. Submit for verification. Restricted scopes need Google's review plus a yearly third party security assessment (CASA). Expect weeks, and an assessment fee from the assessor. Until it passes, only test users added on the consent screen (up to 100) can sign in, and their tokens expire after 7 days.

## 2. Microsoft (Outlook.com, Hotmail and Microsoft 365)

1. Microsoft Entra admin center, App registrations, New registration. Name Multies, supported accounts: any organisational directory and personal Microsoft accounts.
2. Redirect URI (Web): https://multies.si/api/connections/oauth/microsoft/callback.
3. Certificates and secrets: new client secret (note the expiry; rotate before it).
4. API permissions, delegated: openid, email, offline_access, and from "APIs my organization uses", Office 365 Exchange Online: IMAP.AccessAsUser.All and SMTP.Send.
5. Branding: publisher verification with the company's Microsoft Partner Network ID (Fintex Australia Pty Ltd). Without it, work and school users see "unverified" and many tenants block the app.
6. Microsoft 365 admins may still need to allow the app for their tenant and keep IMAP and authenticated SMTP on for the mailbox.

## Why the app password path stays the live one

Microsoft turned off password sign in for IMAP on most Outlook.com and Microsoft 365 accounts (checked 25 October 2026: outlook.office365.com answers "Login is disabled"). The connect form says so in plain words and points to this option once it is on. Gmail, Yahoo, iCloud, Zoho, Fastmail and GMX accept app passwords today.
