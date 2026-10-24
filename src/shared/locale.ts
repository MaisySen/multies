/** Regional defaults. Multies is run from Sydney, so new workspaces start in Australia. */
export const LOCALE = "en-AU";
export const DEFAULT_TIMEZONE = "Australia/Sydney";
export const DEFAULT_COUNTRY = "AU";

/** Countries offered in workspace settings, Australia first. ISO 3166-1 alpha-2. */
export const COUNTRIES = [
  "AU", "NZ", "GB", "IE", "US", "CA", "SG", "HK", "JP", "IN", "NP", "PH", "ID", "MY", "TH", "VN",
  "DE", "FR", "NL", "ES", "IT", "SE", "NO", "DK", "FI", "CH", "AT", "BE", "PT", "PL", "ZA", "BR", "MX", "AE",
] as const;

export function isTimeZone(tz: string) {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
}
