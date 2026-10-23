# Legal documents

The privacy policy, terms of service, acceptable use policy and data processing agreement live in [src/shared/legal.ts](../../src/shared/legal.ts) and render at `/privacy`, `/terms`, `/acceptable-use` and `/dpa`.

They are drafts written against the Privacy Act 1988 and the Australian Privacy Principles, the Spam Act 2003, the Australian Consumer Law and GDPR basics, and every page says so. Before launch:

1. Fill in `LEGAL_ENTITY` (company name, ABN, registered address, contact addresses).
2. Have an Australian lawyer review all four documents, in particular liability, the consumer guarantee wording and the GDPR transfer clauses.
3. Remove the draft banner in `src/web/pages/legal.tsx` and update `LEGAL_UPDATED`.
4. Keep the sub processor table (`SUBPROCESSORS`) in step with reality. Adding a provider that touches customer data needs 30 days notice to customers under the DPA.

## Cookies

The app sets only strictly necessary cookies (the Better Auth session and its sign in protection), with no analytics or advertising cookies, so no consent banner is needed under Australian law or the ePrivacy rules. Adding analytics changes that.

## Data subject requests

| Request | How |
| --- | --- |
| Access or portability (APP 12, GDPR Articles 15 and 20) | Settings, Account, Your data (JSON). Workspace owners: Settings, General, Export workspace data (ZIP with mail). |
| Correction (APP 13) | Profile settings, or by email. |
| Erasure (GDPR Article 17) | Settings, Account, Delete account. Sole owners of shared workspaces must transfer ownership first. Backups expire within 30 days. |
| Audit evidence | Activity, Audit log, Export CSV. |
