import { z } from "zod";

export const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email address").max(254);
export const passwordSchema = z.string().min(10, "Use at least 10 characters").max(200);

export const signupSchema = z.object({
  name: z.string().trim().min(1, "Tell us your name").max(100),
  email: emailSchema,
  password: passwordSchema,
  organization: z.string().trim().max(100).optional(),
});
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1, "Enter your current password"), newPassword: passwordSchema });
export const deleteAccountSchema = z.object({ password: z.string().min(1, "Enter your password") });
export const loginSchema = z.object({ email: emailSchema, password: z.string().min(1, "Enter your password").max(200) });

/** RFC 1035-ish hostname check; rejects IPs, single labels and trailing dots. */
export const domainNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((s) => s.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, ""))
  .pipe(
    z.string()
      .max(253)
      .regex(/^(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/, "Enter a domain like example.com"),
  );

export const localPartSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/, "Use letters, numbers, dots, dashes or underscores")
  .refine((s) => !s.includes(".."), "No consecutive dots");

export const createDomainSchema = z.object({ name: domainNameSchema });

export const createMailboxSchema = z.object({
  domainId: z.string().min(1),
  localPart: localPartSchema,
  displayName: z.string().trim().min(1, "Add a display name").max(100),
  quotaMb: z.number().int().positive().optional(),
});
/** A default Reply-To (MB-61): an address, or null or "" to clear it. */
export const mailboxReplyToSchema = z.union([z.literal(""), z.string().trim().toLowerCase().email("Enter an email address for replies").max(254)]).nullable()
  .transform((v) => (v ? v : null));
export const updateMailboxSchema = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
  replyTo: mailboxReplyToSchema.optional(),
  quotaMb: z.number().int().positive().optional(),
  status: z.enum(["active", "suspended"]).optional(),
});

export const createAliasSchema = z.object({
  domainId: z.string().min(1),
  localPart: localPartSchema,
  destinations: z.array(emailSchema).min(1, "Add at least one destination").max(20),
});
export const updateAliasSchema = z.object({
  destinations: z.array(emailSchema).min(1).max(20).optional(),
  enabled: z.boolean().optional(),
});

export const addressSchema = z.object({ address: emailSchema, name: z.string().max(200).optional() });

export const sendMessageSchema = z.object({
  mailboxId: z.string().min(1),
  to: z.array(emailSchema).min(1, "Add a recipient").max(50),
  cc: z.array(emailSchema).max(50).optional(),
  bcc: z.array(emailSchema).max(50).optional(),
  subject: z.string().max(998).default(""),
  text: z.string().max(1_000_000).default(""),
  html: z.string().max(2_000_000).optional(),
  inReplyToId: z.string().optional(),
  draftId: z.string().optional(),
  // MB-61: where replies go (for example a support inbox when sending from no-reply@).
  replyTo: emailSchema.optional(),
});

export const saveDraftSchema = sendMessageSchema.extend({
  to: z.array(emailSchema).max(50).default([]),
  id: z.string().optional(),
});

export const updateMessageSchema = z.object({
  isRead: z.boolean().optional(),
  isStarred: z.boolean().optional(),
  folder: z.enum(["inbox", "archive", "spam", "trash"]).optional(),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateMailboxInput = z.infer<typeof createMailboxSchema>;
export type CreateAliasInput = z.infer<typeof createAliasSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
