import { and, eq } from "drizzle-orm";
import type { DB } from "../../db";
import { mailConnections } from "../../db/schema";
import { HttpError } from "../../lib/errors";

/**
 * Wave 2 review X6: a mailbox whose connection waits for its emailed code (P60) has not shown the address is the
 * person's, so nothing is put into it: no import (IMAP or .mbox) and no draft. One indexed read (the connection's
 * unique mailbox index). Sending is refused the same way in mail/send.ts.
 */
export async function assertNotWaitingForCode(db: DB, mailboxId: string, address?: string) {
  const w = await db.select({ id: mailConnections.id }).from(mailConnections)
    .where(and(eq(mailConnections.mailboxId, mailboxId), eq(mailConnections.status, "verifying"))).get();
  if (w) throw new HttpError(409, "connection_unverified", `${address ?? "This mailbox"} waits for the code we emailed to it. Enter the code in Settings, Connections, Mail accounts, then try again.`);
}
