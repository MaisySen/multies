# Sign in mail (confirmation and password reset)

Added 27 Oct 2026 after a day long outage.

## How it works

On production and staging, sign up, email confirmation and password reset belong to the identity
provider (Auth0 tenant `multies.au.auth0.com`), not the app. The app only asks for them:

* `POST /api/account/resend-verification` asks the tenant to send the confirmation email again
  (the Worker M2M client, `/jobs/verification-email`).
* `POST /api/account/password-reset-link` asks the tenant's public change password endpoint.

The tenant sends the mail itself, through its own email provider setting:

* SMTP `smtp.resend.com:587`, user `resend`, password = the Resend key "Multies Auth0 sign-in mail"
  (send only, domain multies.si only), kept in `~/.multies-secrets/multies-resend-auth0.json`.
* From `Multies <no-reply@multies.si>`.
* Templates `verify_email` and `reset_email` are ours (plain Multies copy, no dashes). The free tenant
  cannot set a result URL, so after confirming, the tenant shows its own "email verified" page.

That key is separate from the app's own `RESEND_API_KEY` on purpose: rotating the app key must not
touch sign in mail. If you ever rotate the Auth0 one, PATCH `/api/v2/emails/provider` with the new
`credentials.smtp_pass` in the same step, then run the check below.

## What broke on 26 Oct 2026

The tenant's SMTP password was the app's old Resend key. The R28 rotation revoked that key on
26 Oct about 02:16 UTC. From then every confirmation and reset failed at the tenant with
`Error sending email: Invalid login: 535 Authentication credentials invalid`, while the app, its
smoke checks and the resend endpoint (which only queues the job) all looked fine. Found on 27 Oct
from the tenant logs (type `fn`), fixed at 00:46 UTC with the dedicated key.

## Check it

```
node scripts/creds.mjs run RESEND_API_KEY -- node scripts/auth-mail-check.mjs --probe --minutes 30
```

* Read only part: the tenant's email provider is on, and it logged no failed email (`fn`) in the window.
* `--probe`: creates a throwaway user at a plus address of our test inbox (`~/.multies-secrets/auth-mail-probe.json`) with verify_email on,
  waits until Resend shows that confirmation as sent or delivered (or the tenant logs a failure),
  then deletes the user. About 10 seconds, one email.
* `scripts/smoke.sh` runs it on production deploys (step 6). `SMOKE_AUTH_MAIL=0` skips it.
  Exit 1 is a failure, exit 2 means it could not run (no secrets on this machine), a warning.

## If it fails

1. Tenant logs: Management API `GET /api/v2/logs?q=type:fn` shows the provider's own error.
2. `535` or another login error: the SMTP key is wrong or revoked. Make a new send only key for
   multies.si in Resend, store it in the secrets file above, PATCH the email provider.
3. Resend side: `GET https://api.resend.com/emails` shows each message's last event (bounced,
   suppressed). A domain problem shows on `GET /domains`.
4. Never mark an account verified by hand to get around it; fix the sending and resend.
