# Legal documents

The privacy policy, terms of service, acceptable use policy and data processing agreement live in [src/shared/legal.ts](../../src/shared/legal.ts) and render at `/privacy`, `/terms`, `/acceptable-use` and `/dpa`.

They are final, effective 27 October 2026, issued by Fintex Australia Pty Ltd (ABN 60 688 406 108) and governed by the laws of New South Wales, Australia. The owner and director decided on 27 October 2026 to publish them as final without a draft notice. They are written against the Privacy Act 1988 and the Australian Privacy Principles, the Spam Act 2003, the Australian Consumer Law and GDPR basics.

Keeping them true:

1. `LEGAL_ENTITY` and `LEGAL_LINE` hold the company details from the company runbook (no street address).
2. When the product changes in a way the documents describe (a plan rule, retention, a feature), change the text and update `LEGAL_EFFECTIVE` and `LEGAL_UPDATED`. Material changes need 30 days notice by email to account owners.
3. Keep the sub processor table (`SUBPROCESSORS`) in step with reality and with `src/shared/trust.ts`. Adding a provider that touches customer data needs 30 days notice to customers under the DPA.
4. `tests/legal.test.ts` fails if a draft or review notice comes back.

## Cookies

The app sets only strictly necessary cookies (the Better Auth session and its sign in protection), with no analytics or advertising cookies, so no consent banner is needed under Australian law or the ePrivacy rules. Adding analytics changes that.

## Data subject requests

| Request | How |
| --- | --- |
| Access or portability (APP 12, GDPR Articles 15 and 20) | Settings, Account, Your data (JSON). Workspace owners: Settings, General, Export workspace data (ZIP with mail). |
| Correction (APP 13) | Profile settings, or by email. |
| Erasure (GDPR Article 17) | Settings, Account, Delete account. Sole owners of shared workspaces must transfer ownership first. Backups expire within 30 days. |
| Audit evidence | Activity, Audit log, Export CSV. |
