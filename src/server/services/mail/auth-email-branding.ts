/**
 * Branded auth emails (R25, MB-60, found by Haajir): per hook logo, brand colour, reply-to, footer line,
 * per type subject / intro / button label with {appName}, {code} and {email} placeholders, and an
 * optional second language block under the main text (Nepali under English, for example).
 *
 * Everything the caller sets is plain text. It is HTML escaped when rendered and never taken as HTML;
 * the logo must be an https URL and the colour a hex value, so neither can carry markup or CSS.
 * With nothing set the email is byte for byte the one authEmail() writes (the round 13 layout).
 */
import { z } from "zod";

export const AUTH_EMAIL_TYPES = ["signup", "invite", "magiclink", "recovery", "email_change", "email", "reauthentication"] as const;
export type AuthEmailType = (typeof AUTH_EMAIL_TYPES)[number];

export const BRANDING_LIMITS = { subject: 200, intro: 2000, buttonLabel: 60, footer: 300, note: 300, logoUrl: 500, lang: 16 } as const;

/** True when s holds a control character other than those in allowed (by char code). */
const hasControl = (s: string, allowed: number[] = []) => [...s].some((ch) => { const n = ch.charCodeAt(0); return (n < 32 || n === 127) && !allowed.includes(n); });
/** One line: no line breaks or other control characters (they would break a mail header). */
const oneLine = (max: number) => z.string().trim().max(max).refine((s) => !hasControl(s), "Use one line, without line breaks.");
/** A paragraph: line breaks allowed, other control characters not. */
const para = (max: number) => z.string().trim().max(max).refine((s) => !hasControl(s, [10, 13]), "Plain text only.");

export const TemplateSchema = z.object({
  subject: oneLine(BRANDING_LIMITS.subject).optional(),
  intro: para(BRANDING_LIMITS.intro).optional(),
  buttonLabel: oneLine(BRANDING_LIMITS.buttonLabel).optional(),
}).strict();
export type AuthEmailTemplate = z.infer<typeof TemplateSchema>;

const templatesShape = Object.fromEntries(AUTH_EMAIL_TYPES.map((t) => [t, TemplateSchema.nullable().optional()])) as Record<AuthEmailType, z.ZodOptional<z.ZodNullable<typeof TemplateSchema>>>;
export const TemplatesSchema = z.object(templatesShape).strict();

export const SecondaryLanguageSchema = z.object({
  lang: z.string().trim().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "Use a language tag such as ne or ne-NP.").max(BRANDING_LIMITS.lang).optional(),
  templates: TemplatesSchema,
  note: oneLine(BRANDING_LIMITS.note).optional(),
}).strict();

export const LogoUrlSchema = z.string().trim().max(BRANDING_LIMITS.logoUrl).refine((s) => {
  if (/[\s"'<>\\]/.test(s)) return false;
  try { const u = new URL(s); return u.protocol === "https:" && !!u.hostname && !u.username && !u.password; } catch { return false; }
}, "logoUrl must be an https:// image URL.");
export const BrandColorSchema = z.string().trim().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "brandColor must be a hex colour such as #0071E3.");
export const ReplyToSchema = z.string().trim().toLowerCase().email("replyTo must be an email address.").max(254);

/** What PATCH and create take. null clears a field; templates merge per type. */
export const BrandingInputSchema = z.object({
  logoUrl: LogoUrlSchema.nullable().optional(),
  brandColor: BrandColorSchema.nullable().optional(),
  replyTo: ReplyToSchema.nullable().optional(),
  footer: oneLine(BRANDING_LIMITS.footer).nullable().optional(),
  templates: TemplatesSchema.nullable().optional(),
  secondaryLanguage: SecondaryLanguageSchema.nullable().optional(),
}).strict();
export type BrandingInput = z.infer<typeof BrandingInputSchema>;

/** What is stored (the hook's branding JSON column) and shown by GET. */
export interface AuthEmailBranding {
  logoUrl?: string;
  brandColor?: string;
  replyTo?: string;
  footer?: string;
  templates?: Partial<Record<AuthEmailType, AuthEmailTemplate>>;
  secondaryLanguage?: { lang?: string; templates: Partial<Record<AuthEmailType, AuthEmailTemplate>>; note?: string };
}

function cleanTemplates(t: Partial<Record<AuthEmailType, AuthEmailTemplate | null | undefined>> | null | undefined) {
  const out: Partial<Record<AuthEmailType, AuthEmailTemplate>> = {};
  for (const type of AUTH_EMAIL_TYPES) {
    const v = t?.[type];
    if (!v) continue;
    const c: AuthEmailTemplate = {};
    if (v.subject) c.subject = v.subject;
    if (v.intro) c.intro = v.intro.replace(/\r\n?/g, "\n");
    if (v.buttonLabel) c.buttonLabel = v.buttonLabel;
    if (Object.keys(c).length) out[type] = c;
  }
  return out;
}

const normColor = (c: string) => {
  const h = c.toLowerCase();
  return h.length === 4 ? `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}` : h;
};

/**
 * Applies a PATCH (or a create body) to the stored branding. Top level keys replace; null clears;
 * templates merge per type (a type set to null goes back to the default text). Returns null when
 * nothing is left, so the column goes back to NULL and the email to the default layout.
 */
export function mergeBranding(current: AuthEmailBranding | null, patch: BrandingInput | null | undefined): AuthEmailBranding | null {
  if (patch === null) return null;
  const next: AuthEmailBranding = { ...(current ?? {}) };
  if (patch) {
    if (patch.logoUrl !== undefined) { if (patch.logoUrl) next.logoUrl = patch.logoUrl; else delete next.logoUrl; }
    if (patch.brandColor !== undefined) { if (patch.brandColor) next.brandColor = normColor(patch.brandColor); else delete next.brandColor; }
    if (patch.replyTo !== undefined) { if (patch.replyTo) next.replyTo = patch.replyTo; else delete next.replyTo; }
    if (patch.footer !== undefined) { if (patch.footer) next.footer = patch.footer; else delete next.footer; }
    if (patch.templates !== undefined) {
      if (patch.templates === null) delete next.templates;
      else {
        const merged: Partial<Record<AuthEmailType, AuthEmailTemplate | null>> = { ...(next.templates ?? {}) };
        for (const type of AUTH_EMAIL_TYPES) if (patch.templates[type] !== undefined) merged[type] = patch.templates[type];
        const t = cleanTemplates(merged);
        if (Object.keys(t).length) next.templates = t; else delete next.templates;
      }
    }
    if (patch.secondaryLanguage !== undefined) {
      if (!patch.secondaryLanguage) delete next.secondaryLanguage;
      else {
        const t = cleanTemplates(patch.secondaryLanguage.templates);
        const s: NonNullable<AuthEmailBranding["secondaryLanguage"]> = { templates: t };
        if (patch.secondaryLanguage.lang) s.lang = patch.secondaryLanguage.lang;
        if (patch.secondaryLanguage.note) s.note = patch.secondaryLanguage.note;
        if (Object.keys(t).length || s.note) next.secondaryLanguage = s; else delete next.secondaryLanguage;
      }
    }
  }
  return Object.keys(next).length ? next : null;
}

/** Reads the stored column; anything unreadable counts as no branding (the default email). */
export function parseBranding(raw: string | null | undefined): AuthEmailBranding | null {
  if (!raw) return null;
  try {
    const v = BrandingInputSchema.safeParse(JSON.parse(raw));
    return v.success ? mergeBranding(null, v.data) : null;
  } catch { return null; }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));

/** The round 13 copy. {app} is the default text's own placeholder. */
export const DEFAULT_COPY: Record<string, { subject: string; lead: string; button: string }> = {
  signup: { subject: "Confirm your email for {app}", lead: "Confirm your email address to finish signing up for {app}.", button: "Confirm email" },
  invite: { subject: "You're invited to {app}", lead: "You have been invited to {app}. Accept the invitation to set up your account.", button: "Accept invitation" },
  magiclink: { subject: "Your sign in link for {app}", lead: "Use this link to sign in to {app}. It works once and expires soon.", button: "Sign in" },
  recovery: { subject: "Reset your {app} password", lead: "Someone asked to reset the password for your {app} account. If it was you, choose a new one.", button: "Reset password" },
  email_change: { subject: "Confirm your email change for {app}", lead: "Confirm this address for your {app} account.", button: "Confirm change" },
  email: { subject: "Your {app} code", lead: "Here is your {app} sign in code.", button: "" },
  reauthentication: { subject: "Your {app} confirmation code", lead: "Enter this code in {app} to confirm it's you.", button: "" },
};
const FALLBACK_COPY = { subject: "A message from {app}", lead: "Here is your {app} link.", button: "Open" };
const IGNORE = "If you didn't ask for this, you can ignore this email.";
const DEFAULT_COLOR = "#0071e3";

/** White text on dark brand colours, near black on light ones (WCAG relative luminance). */
export function buttonTextColor(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return l > 0.45 ? "#1d1d1f" : "#fff";
}

export interface AuthEmailVars { appName: string; email: string; code?: string }

/** Fills {appName}, {code} and {email} (and the default text's {app}). Other braces stay as typed. */
export function fillPlaceholders(s: string, v: AuthEmailVars) {
  return s.replace(/\{(appName|app|code|email)\}/g, (_m, k: string) => (k === "code" ? (v.code ?? "") : k === "email" ? v.email : v.appName));
}

const paragraphs = (s: string, style = "") => s.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  .map((p) => `<p${style ? ` style="${style}"` : ""}>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
const oneLineText = (s: string) => s.replace(/[\r\n\t]+/g, " ").trim();

export interface RenderedAuthEmail { subject: string; text: string; html: string; replyTo?: string }

/**
 * One auth email with the hook's branding. Same structure as the round 13 email; each branding
 * option adds or replaces only its own part, so with nothing set the output is identical.
 */
export function renderAuthEmail(branding: AuthEmailBranding | null, type: string, link: string | null, token: string | undefined, vars: AuthEmailVars): RenderedAuthEmail {
  const b = branding ?? {};
  const known = (AUTH_EMAIL_TYPES as readonly string[]).includes(type) ? (type as AuthEmailType) : null;
  const base = DEFAULT_COPY[type] ?? FALLBACK_COPY;
  const custom = known ? b.templates?.[known] : undefined;
  const v: AuthEmailVars = { appName: vars.appName, email: oneLineText(vars.email), code: token };
  const fill = (s: string) => fillPlaceholders(s, v);
  const subject = oneLineText(fill(custom?.subject ?? base.subject));
  const lead = fill(custom?.intro ?? base.lead);
  // A type without a link (codes only) shows no button whatever the label says.
  const button = base.button ? fill(custom?.buttonLabel ?? base.button) : "";
  const second = known ? b.secondaryLanguage?.templates[known] : undefined;
  const secondNote = b.secondaryLanguage?.note;
  // The block shows when this type has text in the second language; its note rides with it.
  const hasSecond = !!(second && (second.intro || (second.buttonLabel && link && base.button) || secondNote));
  const color = b.brandColor ?? DEFAULT_COLOR;
  const fg = b.brandColor ? buttonTextColor(b.brandColor) : "#fff";

  const lines = [lead, ""];
  if (link) lines.push(link, "");
  if (token) lines.push(link ? `Or enter this code: ${token}` : `Your code: ${token}`, "");
  lines.push(IGNORE);
  if (hasSecond) {
    lines.push("");
    if (second?.intro) lines.push(fill(second.intro));
    if (second?.buttonLabel && link && base.button) lines.push(`${fill(second.buttonLabel)}: ${link}`);
    if (secondNote) lines.push(fill(secondNote));
  }
  if (b.footer) lines.push("", fill(b.footer));

  const secondHtml = hasSecond
    ? `<div${b.secondaryLanguage?.lang ? ` lang="${esc(b.secondaryLanguage.lang)}"` : ""} dir="auto" style="border-top:1px solid #d2d2d7;margin-top:20px;padding-top:4px">`
      + (second?.intro ? paragraphs(fill(second.intro)) : "")
      + (second?.buttonLabel && link && base.button ? `<p><a href="${esc(link)}" style="display:inline-block;background:${color};color:${fg};text-decoration:none;padding:10px 18px;border-radius:8px">${esc(fill(second.buttonLabel))}</a></p>` : "")
      + (secondNote ? `<p style="font-size:13px;color:#6e6e73">${esc(fill(secondNote))}</p>` : "")
      + "</div>"
    : "";

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1d1d1f;max-width:480px">`
    + (b.logoUrl ? `<p><img src="${esc(b.logoUrl)}" alt="${esc(vars.appName)}" height="40" style="height:40px;max-width:200px;border:0;display:block"></p>` : "")
    + paragraphs(lead)
    + (link && button ? `<p><a href="${esc(link)}" style="display:inline-block;background:${color};color:${fg};text-decoration:none;padding:10px 18px;border-radius:8px">${esc(button)}</a></p><p style="font-size:13px;color:#6e6e73">Or open this link: ${esc(link)}</p>` : "")
    + (token ? `<p>${link ? "Or enter this code" : "Your code"}: <strong style="font-size:18px;letter-spacing:2px">${esc(token)}</strong></p>` : "")
    + `<p style="font-size:13px;color:#6e6e73">${IGNORE}</p>`
    + secondHtml
    + (b.footer ? `<p style="font-size:12px;color:#86868b">${esc(fill(b.footer))}</p>` : "")
    + "</div>";
  const out: RenderedAuthEmail = { subject, text: lines.join("\n"), html };
  if (second?.subject) out.subject = oneLineText(`${subject} / ${fill(second.subject)}`);
  if (b.replyTo) out.replyTo = b.replyTo;
  return out;
}
