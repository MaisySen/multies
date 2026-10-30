# Sign in with Google and Microsoft (internal)

Round 25. The sign in and sign up pages show "Continue with Google" and "Continue with Microsoft"
when the deployment turns them on. Both go through our identity provider (Auth0 tenant
`multies.au.auth0.com`): the app sends the person to `/authorize` with `connection=google-oauth2`
or `connection=windowslive`, Auth0 skips its own page and opens Google or Microsoft, and the
person comes back through the usual callback `/api/auth/callback/auth0`.

## Switches

| Where | Setting | Effect |
| --- | --- | --- |
| Worker var | `AUTH0_SOCIAL_CONNECTIONS="google-oauth2,windowslive"` | Shows those buttons (published on `/api/config` as `socialConnections`). Unset or empty: no buttons. Unknown names are ignored. Needs the identity provider (AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET). |
| Auth0 | connection enabled for the web client the deployment uses | Without it Auth0 answers the button with an error page instead of Google or Microsoft. |

Staging uses its own Auth0 web client, "Multies Staging" (CREDENTIALS.local.md, section
"Auth0 staging web client"), so a connection can be tried on staging without showing on
production's Universal Login. Production uses the "Multies" client.

Connections on the tenant (25 Oct 2026):

| Connection | Id | Keys | Enabled for |
| --- | --- | --- | --- |
| google-oauth2 | con_pQyqA41JUuDFBUlC | Auth0 developer keys, scopes email and profile | Multies (prod, since round 19), Multies Staging, Multies Mobile |
| windowslive (Microsoft Account) | con_X3QpEbpn56wDicki | Auth0 developer keys, wl.basic, wl.emails, wl.signin | Multies Staging only |

Check one from a shell (no sign in happens, it only follows the first redirect):

```
curl -s -o /dev/null -w "%{redirect_url}\n" "https://multies.au.auth0.com/authorize?response_type=code&client_id=<CLIENT_ID>&redirect_uri=https://preview.multies.si/api/auth/callback/auth0&scope=openid%20profile%20email&state=x&nonce=y&connection=google-oauth2"
```

It should print an `https://accounts.google.com/...` address (`https://login.live.com/...` for
windowslive). `/authorize/resume?...` means the connection is not enabled for that client.

## One person per email

Auth0 keeps a separate user per connection (`google-oauth2|...`, `windowslive|...`, `auth0|...`).
Multies joins them by email: a provider sign in whose ID token says `email_verified: true` (a real
boolean) attaches to the existing Multies account with that address and lands in the same
workspace. Anything else (false, missing, the string "true") is refused with "account not linked"
and the sign in page explains it; no second person is ever made for an address that already has
an account. No provider is trusted by name (`src/server/auth/linking.ts`,
`src/server/auth/social-connections.ts`). Google always reports verified addresses. Microsoft
personal accounts may report the address as unverified; such people can still sign in with the
email and password or code they already use.

## Developer keys and their limits

Auth0's developer keys are fine for staging: Google's consent screen names Auth0 instead of
Multies, Auth0 shows a warning banner, and single sign on sessions and some profile fields are
limited. Before turning a connection on for production, put our own keys in.

## Our own Google OAuth client

1. Google Cloud console, https://console.cloud.google.com/ , pick (or create) the project
   "Multies" under the Fintex Australia organisation.
2. APIs and Services, OAuth consent screen (Google Auth Platform, Branding): app name
   "Multies", support email support@multies.si, logo, home page https://multies.si , privacy
   https://multies.si/privacy/ , terms https://multies.si/terms/ . Authorised domains:
   `multies.si` and `auth0.com`. Audience: External. Scopes (Data access): `openid`,
   `.../auth/userinfo.email`, `.../auth/userinfo.profile` (no sensitive scopes, so no review).
   Publish the app (In production).
3. Clients, Create client: type "Web application", name "Multies Auth0".
   Authorised JavaScript origins: `https://multies.au.auth0.com`.
   Authorised redirect URIs: `https://multies.au.auth0.com/login/callback`.
4. Copy the client id and client secret into CREDENTIALS.local.md.
5. Auth0, Authentication, Social, google-oauth2 (or Management API
   `PATCH /api/v2/connections/con_pQyqA41JUuDFBUlC` with the whole `options` object):
   `client_id` = the Google client id, `client_secret` = the secret, keep `email: true`,
   `profile: true`, `scope: ["email", "profile"]`. Save, then run the curl check above: the
   Google address should now carry our client id.

## Our own Microsoft app registration

1. Azure portal, https://portal.azure.com/ , Microsoft Entra ID, App registrations, New registration.
2. Name "Multies". Supported account types: "Accounts in any organizational directory and
   personal Microsoft accounts" (personal accounts are what the windowslive connection serves).
3. Redirect URI: platform Web, `https://multies.au.auth0.com/login/callback`. Register.
4. Certificates and secrets, New client secret, 24 months. Copy the Value (shown once) and the
   Application (client) id from Overview into CREDENTIALS.local.md. Note the expiry date there.
5. API permissions: Microsoft Graph, delegated `openid`, `email`, `profile`, `User.Read`
   (granted by default for personal accounts; no admin consent needed).
6. Branding and properties: publisher domain multies.si (verify the domain if asked), home page,
   terms and privacy URLs as above.
7. Auth0, Authentication, Social, windowslive (or `PATCH /api/v2/connections/con_X3QpEbpn56wDicki`
   with the whole `options` object): `client_id` = the Application id, `client_secret` = the
   secret value. Keep `signin`, `emails` and `basic` on. Save and run the curl check with
   `connection=windowslive`: the login.live.com (or login.microsoftonline.com) address should
   carry our Application id.

## Turning it on

1. Staging: Worker var `AUTH0_SOCIAL_CONNECTIONS = "google-oauth2,windowslive"` under
   `[env.staging.vars]` in wrangler.toml, and the staging Worker secrets AUTH0_CLIENT_ID and
   AUTH0_CLIENT_SECRET set to the "Multies Staging" client. Deploy, then one GET of
   `https://preview.multies.si/api/config` should show `"socialConnections":["google-oauth2","windowslive"]`.
2. Production, after our own keys are in: enable windowslive for the "Multies" client
   (`PATCH /api/v2/connections/con_X3QpEbpn56wDicki/clients` with
   `[{"client_id": "<Multies client id>", "status": true}]`), then
   `AUTH0_SOCIAL_CONNECTIONS = "google-oauth2,windowslive"` under `[vars]`, deploy, check
   `/api/config`. To show only Google, set `"google-oauth2"`.
3. Turning it off: remove the var (buttons go away at once). The Auth0 connections can stay.
