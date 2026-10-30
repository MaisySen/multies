/**
 * R59: the sender address a mail row carries while its headers could not be read yet (an older message whose header
 * block was longer than the backfill's first peek, before R59). Mail lists and folder counts leave these rows out; the
 * connected mailbox sync reads their headers again (services/connect/sync.ts, repairStep). Never shown to anyone.
 */
export const PENDING_FROM = "unknown@invalid";
