# Trust page

Round 15. A public page at `multies.si/trust` (footer: Legal, Security and trust; in the sitemap)
that answers the questions a security review asks: data region, sub processors, backups, sign in
options, encryption, incident history and where to report a problem. `security.txt` now points its
`Policy` at `/trust` (it pointed at `/security`, which has no page).

## Rule: only what is true today

Content lives in `src/shared/trust.ts`. Every block has a comment naming its source (config,
`wrangler.toml`, a doc in this repo, or the provider's own documentation). When the code changes,
change this file in the same commit. Claims that could not be checked are left out.

`tests/trust.test.ts` checks what can be checked mechanically:

- every provider setting in `src/server/config.ts` is either a sub processor row or listed with the
  reason it is not (for example push through Expo, which is off in production);
- the production database is `mymail-au` and the Worker is placed in Sydney;
- HSTS, AES-GCM, passkeys and the Time Travel window match the code and docs;
- the route is known, has its own title and is in the sitemap; the copy has no dashes or stock phrases.

## Keeping it current

- New provider: add a row (name, purpose, data, where, `always` or `optional`, its env vars). The
  privacy policy and DPA table in `src/shared/legal.ts` must list it too, with the notice the DPA
  promises.
- Incident: add it to `INCIDENTS`, newest first, the same day: what people saw, and what changed.
- Turning on push, Xero, the external body store or the direct Google and GitHub sign in in
  production: move it from the test's `NOT_LISTED` to a row.
