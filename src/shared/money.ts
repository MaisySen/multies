/**
 * Billing money, one formatter for every amount a customer sees in Multies' own billing
 * surfaces: receipts and other billing mail, the Billing page, the pricing calculator.
 *
 * Multies charges in Australian dollars, and "$3.50" alone reads as US dollars to many
 * people, so an AUD amount always reads "A$3.50". An amount in any other currency (a
 * Stripe object carries its own currency code) shows that code: "USD 3.50".
 * Display only: nothing here changes what Stripe charges.
 */
export const BILLING_CURRENCY = "aud";

/** Digits a currency uses (2 for AUD and USD, 0 for JPY), read from Intl. */
function fractionDigits(code: string) {
  try { return new Intl.NumberFormat("en-AU", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits ?? 2; } catch { return 2; }
}

/** The prefix an amount carries: "A$" for AUD, else the currency code and a space. */
export function currencyPrefix(currency: string = BILLING_CURRENCY) {
  const code = (currency || BILLING_CURRENCY).toUpperCase();
  return code === "AUD" ? "A$" : `${code} `;
}

export interface MoneyOptions {
  /** "auto" (default) drops ".00" on whole amounts; "always" keeps the cents. */
  cents?: "auto" | "always";
}

/**
 * A major unit amount (dollars) for display: formatMoney(3.5) is "A$3.50", formatMoney(12) is "A$12",
 * formatMoney(-2.1) is "-A$2.10", formatMoney(3.5, "usd") is "USD 3.50".
 */
export function formatMoney(amount: number, currency: string = BILLING_CURRENCY, opts: MoneyOptions = {}) {
  const code = (currency || BILLING_CURRENCY).toUpperCase();
  const digits = fractionDigits(code);
  const n = Number.isFinite(amount) ? amount : 0;
  const whole = Math.abs(n * 10 ** digits) % 10 ** digits === 0;
  const min = opts.cents === "always" || !whole ? digits : 0;
  const body = new Intl.NumberFormat("en-AU", { minimumFractionDigits: min, maximumFractionDigits: digits }).format(Math.abs(n));
  const sign = n < 0 && body.replace(/[^1-9]/g, "") !== "" ? "-" : "";
  return `${sign}${currencyPrefix(code)}${body}`;
}

/**
 * A Stripe minor unit amount (cents) with its currency, always with cents: formatCents(350, "aud") is "A$3.50".
 * Money that came from Stripe (invoices, charges, previews) goes through here.
 */
export function formatCents(cents: number | null | undefined, currency: string | null | undefined = BILLING_CURRENCY) {
  const code = (currency || BILLING_CURRENCY).toUpperCase();
  return formatMoney((cents ?? 0) / 10 ** fractionDigits(code), code, { cents: "always" });
}

/**
 * Text Stripe wrote, such as an invoice line "1 x Mailbox pack (at $3.00 / month)": a bare "$" before a number
 * becomes the currency's prefix ("A$3.00"). Amounts that already carry a prefix ("A$", "US$") are left alone.
 */
export function localizeStripeText(text: string, currency: string | null | undefined = BILLING_CURRENCY) {
  const prefix = currencyPrefix(currency || BILLING_CURRENCY);
  // nosemgrep: regex_dos (one character class and a lookahead, linear time)
  return text.replace(/(^|[^A-Za-z$])\$(?=\d)/g, (_m, before: string) => `${before}${prefix}`);
}

/** Said once per billing surface, beside the prices: Multies prices exclude GST. */
export const EXCL_GST = "excl. GST";
