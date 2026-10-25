# Auth0 automatic migration from the old tenant (DF-19)

Sign in moved from the old Auth0 tenant (dev-s8n2ciq6co7gzsec.us.auth0.com) to multies.au.auth0.com on 25 October 2026. Passwords cannot be exported on the free plan, so the new tenant's database connection (Username-Password-Authentication) runs in import mode with two custom scripts:

- `login.js`: runs only for an email the new tenant does not have yet. It checks the password against the old tenant (password realm grant through the client "Multies legacy password check"), and on success the new tenant keeps the person, with the same user id as before, and their password. The old tenant is never asked again for that person.
- `get_user.js`: used by sign up and Forgot password. It finds a person who is still only on the old tenant (through the M2M client "Multies legacy user lookup", read:users only), so a reset creates them on the new tenant. If the old tenant cannot be reached it answers "not found", so sign up never breaks.

The scripts read their settings from the connection's encrypted configuration: OLD_DOMAIN, OLD_PW_CLIENT_ID, OLD_PW_CLIENT_SECRET, OLD_LOOKUP_CLIENT_ID, OLD_LOOKUP_CLIENT_SECRET. The values are in CREDENTIALS.local.md (never in this repo).

On the old tenant, the post-login Action "Multies login policy" returns early for the password check client, so only the password is checked there; the new tenant applies its own policy (confirmed email, second factor).

Turning customisation on needs an empty connection: on 25 October the two users the new tenant had were removed, customisation turned on, and both recreated with their same ids and passwords.

Keep the old tenant until nobody is left on it (Management API: users on the old tenant whose email is not on the new one). Then turn import mode off and delete the two old tenant clients.

Tests: tests/auth0-legacy-migration.test.ts runs both scripts against a fake old tenant.
