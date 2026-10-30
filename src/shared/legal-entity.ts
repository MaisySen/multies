/**
 * R74: the company details and the footer legal line on their own, so a page footer does not pull the full legal
 * documents (about 40 KB) into the first file every page loads. src/shared/legal.ts re-exports these.
 */
export const LEGAL_ENTITY = {
  name: "Fintex Australia Pty Ltd",
  abn: "60 688 406 108",
  acn: "688 406 108",
  address: "New South Wales, Australia",
  // Every public contact uses the company address until the multies.si mailboxes are routed into a read inbox.
  privacyEmail: "contact@fintex.au",
  abuseEmail: "contact@fintex.au",
  supportEmail: "contact@fintex.au",
  contactEmail: "contact@fintex.au",
  website: "https://fintex.au",
};

/**
 * The standard legal line for page footers and the trust page, word for word from the company
 * runbook. Render it with the company name linked to LEGAL_ENTITY.website (see LegalLine).
 */
export const LEGAL_LINE = {
  before: "Multies is provided by ",
  company: LEGAL_ENTITY.name,
  after: ` (ABN ${LEGAL_ENTITY.abn}), New South Wales, Australia. Contact: ${LEGAL_ENTITY.contactEmail}.`,
};
export const LEGAL_LINE_TEXT = LEGAL_LINE.before + LEGAL_LINE.company + LEGAL_LINE.after;
