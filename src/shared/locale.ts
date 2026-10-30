/**
 * Regional settings. Multies is used worldwide: nothing here assumes a country or a time zone.
 * A new workspace starts in UTC until onboarding saves the person's own zone and country,
 * which the browser fills in (Intl and navigator.language).
 */
/** Number and date formatting before a person's own language is known. */
export const LOCALE = "en-AU";
export const DEFAULT_TIMEZONE = "UTC";
/** Used only when nothing better is known (no browser hint, no edge country). */
export const DEFAULT_COUNTRY = "US";

/** Every country in ISO 3166-1 alpha-2 (249 codes). Names come from Intl.DisplayNames in the person's language. */
export const COUNTRIES = [
  "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT", "AU", "AW", "AX", "AZ", "BA", "BB", "BD", "BE",
  "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS", "BT", "BV", "BW", "BY", "BZ", "CA", "CC", "CD",
  "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN", "CO", "CR", "CU", "CV", "CW", "CX", "CY", "CZ", "DE", "DJ", "DK", "DM",
  "DO", "DZ", "EC", "EE", "EG", "EH", "ER", "ES", "ET", "FI", "FJ", "FK", "FM", "FO", "FR", "GA", "GB", "GD", "GE", "GF",
  "GG", "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY", "HK", "HM", "HN", "HR", "HT", "HU",
  "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR", "IS", "IT", "JE", "JM", "JO", "JP", "KE", "KG", "KH", "KI", "KM", "KN",
  "KP", "KR", "KW", "KY", "KZ", "LA", "LB", "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY", "MA", "MC", "MD", "ME",
  "MF", "MG", "MH", "MK", "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ", "NA",
  "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ", "OM", "PA", "PE", "PF", "PG", "PH", "PK", "PL", "PM",
  "PN", "PR", "PS", "PT", "PW", "PY", "QA", "RE", "RO", "RS", "RU", "RW", "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI",
  "SJ", "SK", "SL", "SM", "SN", "SO", "SR", "SS", "ST", "SV", "SX", "SY", "SZ", "TC", "TD", "TF", "TG", "TH", "TJ", "TK",
  "TL", "TM", "TN", "TO", "TR", "TT", "TV", "TW", "TZ", "UA", "UG", "UM", "US", "UY", "UZ", "VA", "VC", "VE", "VG", "VI",
  "VN", "VU", "WF", "WS", "YE", "YT", "ZA", "ZM", "ZW",
] as const;
export type Country = (typeof COUNTRIES)[number];

export function isCountry(c: string): c is Country {
  return (COUNTRIES as readonly string[]).includes(c);
}

export function isTimeZone(tz: string) {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
}

/**
 * Languages a person can pick. The product is in English for now; the choice formats dates and
 * numbers today and picks the translation when it ships (plan horizon 2).
 */
export const LANGUAGES = ["en", "es", "pt", "fr", "de", "it", "nl", "hi", "ne", "id", "ja", "zh", "ko", "ar", "tr", "vi", "th", "pl", "sv", "ms", "fil", "bn", "ur", "ru", "uk"] as const;
export type Language = (typeof LANGUAGES)[number];

/** A BCP 47 tag we can format with ("pt-BR", "en-GB", "fr"), or null. */
export function cleanLocale(tag: string | null | undefined): string | null {
  if (!tag) return null;
  try { return Intl.getCanonicalLocales(tag)[0] ?? null; } catch { return null; }
}

/** The country part of a locale tag ("pt-BR" gives "BR"), when it is a real country. */
export function countryFromLocale(tag: string | null | undefined): Country | null {
  const region = cleanLocale(tag)?.split("-").find((p, i) => i > 0 && /^[A-Z]{2}$/.test(p));
  return region && isCountry(region) ? region : null;
}

/**
 * Billing is in Australian dollars. Prices can be shown in the visitor's currency for reading
 * only, converted with the day's reference rate. Countries not listed see Australian dollars.
 */
export const COUNTRY_CURRENCY: Partial<Record<Country, string>> = {
  AU: "AUD", NZ: "NZD", US: "USD", CA: "CAD", GB: "GBP", IE: "EUR", JP: "JPY", IN: "INR", SG: "SGD", HK: "HKD",
  CN: "CNY", KR: "KRW", ID: "IDR", MY: "MYR", TH: "THB", PH: "PHP", IL: "ILS", ZA: "ZAR", BR: "BRL", MX: "MXN",
  CH: "CHF", NO: "NOK", SE: "SEK", DK: "DKK", PL: "PLN", CZ: "CZK", HU: "HUF", RO: "RON", BG: "BGN", IS: "ISK", TR: "TRY",
  DE: "EUR", FR: "EUR", ES: "EUR", IT: "EUR", NL: "EUR", BE: "EUR", AT: "EUR", PT: "EUR", FI: "EUR", GR: "EUR", SK: "EUR",
  SI: "EUR", LU: "EUR", LV: "EUR", LT: "EUR", EE: "EUR", MT: "EUR", CY: "EUR", HR: "EUR",
};

/** The browser's best guess at the person's country: the locale's region, else a few well known zones. */
export function guessCountry(locale: string | null, zone: string | null): Country | null {
  const fromLocale = countryFromLocale(locale);
  if (fromLocale) return fromLocale;
  const byZone: Record<string, string> = {
    "America/Sao_Paulo": "BR", "Europe/Paris": "FR", "Europe/Berlin": "DE", "Europe/London": "GB", "Asia/Kathmandu": "NP", "Asia/Kolkata": "IN",
    "Australia/Sydney": "AU", "Australia/Melbourne": "AU", "America/New_York": "US", "America/Los_Angeles": "US", "Asia/Tokyo": "JP", "Asia/Singapore": "SG",
  };
  const c = zone ? byZone[zone] : undefined;
  return c && isCountry(c) ? c : null;
}

