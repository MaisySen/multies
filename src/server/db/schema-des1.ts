/** DES1: passkeys (WebAuthn) for signing in to the web app (flag PASSKEY_DES1). Public keys and counters only. */
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./schema";

const ts = (name: string) => integer(name, { mode: "timestamp_ms" });

export const passkeysDes1 = sqliteTable("passkeys_des1", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** base64url credential id, as the browser reports it. */
  credentialId: text("credential_id").notNull(),
  /** base64url COSE public key. */
  publicKey: text("public_key").notNull(),
  counter: integer("counter").notNull().default(0),
  /** JSON array of transports (internal, hybrid, usb, nfc, ble), a hint only. */
  transports: text("transports"),
  /** "singleDevice" or "multiDevice" (synced). */
  deviceType: text("device_type"),
  backedUp: integer("backed_up", { mode: "boolean" }).notNull().default(false),
  name: text("name").notNull(),
  createdAt: ts("created_at").notNull().$defaultFn(() => new Date()),
  lastUsedAt: ts("last_used_at"),
}, (t) => [uniqueIndex("passkeys_des1_credential_uq").on(t.credentialId), index("passkeys_des1_user_idx").on(t.userId)]);
