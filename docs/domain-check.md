# Domain mail check and switch plan

Round 14. Two places show the same check: the public page `multies.si/check` (no sign in) and the
domain page in the app, while a domain is not verified yet.

## What it checks

For a domain it reads, over public DNS (DNS over HTTPS, the same resolver as domain verification):

- the MX records, to name who hosts the mail today (Google Workspace or Gmail, Microsoft 365, Zoho,
  Fastmail, Proton, iCloud, GoDaddy, Namecheap, Hostinger, Yandex, Amazon, forwarding services such as
  Cloudflare Email Routing and ImprovMX, and filters such as Mimecast and Proofpoint);
- the SPF record on the apex (missing, duplicated, `+all`, no closing `all`);
- the DMARC record on `_dmarc` (missing, duplicated, no policy, `p=none`);
- the Multies ownership record on `_mymail`. A domain counts as "on Multies" only when that record is
  there and its MX points at a host Multies receives on. Cloudflare Email Routing and the receiving
  MX are shared with other customers of those services, so the MX alone is not enough.

The provider table lives in `src/shared/mail-check.ts`; matching is on whole host name suffixes, so
`google.com.evil.example` is not Google.

## The switch plan

`switchSteps` in `src/server/services/mail-check.ts` writes the steps in the order that loses no
mail: add the domain, publish the sending records (merging SPF, never a second record), create the
same addresses, import old mail over IMAP (with the provider's app password help), lower the MX TTL a
day ahead, switch MX and keep the old account for 14 days with a final import, then tighten DMARC.
Steps drop out when they do not apply (no mail host yet, a forwarding service, Proton without IMAP),
and a filter in front of the real host gets its own step.

## API

`GET /api/check/domain?domain=example.com` answers `{ check }` with `domain`, `checkedAt`,
`provider { id, name, kind, importFrom }`, `mx`, `spf`, `dmarc` (`status`, `message`, `records`) and
`steps`. It accepts a pasted URL. 422 `invalid_domain` for anything that is not a domain name, 502
`dns_unavailable` when both resolvers fail, 429 after 20 fresh checks a minute from one IP.

## Cost

No database reads or writes. The rate limit and a five minute answer cache are in memory per
isolate, and `/api/check/` skips the shared rate limit counter. A test asserts that a check changes
no database rows.
