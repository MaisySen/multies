# ADR 0006: Rename the product to Multies

Status: accepted. Date: 23 to 24 October 2026.

## Context

The product launched as myMail. An existing email app called myMail (by Mail.ru) is on the App
Store and Google Play, so the name could not be owned and would confuse people in the stores.

## Decision

The product is now called Multies, with the domain multies.si. Internal names (the Worker `mymail`,
databases `mymail-au` and `mymail-staging`, the mobile bundle id and package) stay as they are, because
changing them would break deploys, data and store listings.

## Consequences

- Everything people see says Multies; the copy lint fails on the old name in user facing text.
- Internal names and old hosts keep working, so links do not break.
- multies.com is taken, so the product lives on multies.si.
