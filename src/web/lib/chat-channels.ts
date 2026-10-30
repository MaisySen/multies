/**
 * C1 (chat channels, phase 1): the pure logic behind the chat UI in the shared inbox and Settings, Channels, kept
 * apart from the components so unit tests can run it without a browser.
 */
import { PROVIDER_LABEL, windowLeftLabel, type ChannelProvider } from "@/shared/channels";

/** The mail list views (src/web/pages/app/inbox-assign.tsx). */
export type MailView = "open" | "mine" | "unassigned" | "assigned" | "waiting" | "done";

/** The mail view as conversation query params; views that hide done chats say so with hideDone. */
export function chatQuery(view: MailView, assignee: string | null): { qs: string; hideDone: boolean } {
  const p = new URLSearchParams({ limit: "50" });
  let hideDone = true;
  if (view === "mine") p.set("assignee", "me");
  else if (view === "unassigned") p.set("assignee", "none");
  else if (view === "assigned" && assignee) p.set("assignee", assignee);
  else if (view === "waiting") { p.set("status", "waiting"); hideDone = false; }
  else if (view === "done") { p.set("status", "done"); hideDone = false; }
  return { qs: `?${p.toString()}`, hideDone };
}

/** Mail and chats in one list, newest first. */
export function mergeByDate<M extends { lastMessageAt: string }, C extends { lastMessageAt: string }>(mail: M[], chats: C[]): ({ kind: "mail"; item: M } | { kind: "chat"; item: C })[] {
  const all = [...mail.map((item) => ({ kind: "mail" as const, item })), ...chats.map((item) => ({ kind: "chat" as const, item }))];
  return all.sort((a, b) => Date.parse(b.item.lastMessageAt) - Date.parse(a.item.lastMessageAt));
}

/** The pill in the chat header: time left in the reply window, amber under 2 hours, or closed. */
export function windowPill(w: { open: boolean; closesAt: string | null }, now = new Date()): { label: string; tone: "ok" | "warn" | "closed" } {
  const label = windowLeftLabel(w, now);
  if (!label) return { label: "Reply window closed", tone: "closed" };
  const left = Date.parse(w.closesAt!) - now.getTime();
  return { label, tone: left < 2 * 3_600_000 ? "warn" : "ok" };
}

/** The line that replaces the composer once the window has closed. The test channel reads as WhatsApp. */
export function closedWindowCopy(provider: ChannelProvider) {
  const name = provider === "mock" ? "WhatsApp" : PROVIDER_LABEL[provider];
  return `It has been more than 24 hours since this customer wrote, so ${name} only allows an approved template.`;
}

/** Fills {{1}} style placeholders for the preview; empty values keep the placeholder. */
export function fillTemplate(body: string, params: string[]) {
  return body.replace(/\{\{(\d+)\}\}/g, (all, n: string) => { const v = params[Number(n) - 1]; return v && v.trim() ? v : all; });
}

/** What the WA_EMBEDDED_SIGNUP window message tells us. Only messages from facebook.com count. */
export type SignupEvent = { kind: "finish"; phoneNumberId: string; wabaId: string } | { kind: "cancel"; step: string | null } | { kind: "error"; message: string | null };
export function parseSignupMessage(origin: string, data: unknown): SignupEvent | null {
  if (!/^https:\/\/([a-z0-9-]+\.)*facebook\.com$/.test(origin)) return null;
  let d: { type?: string; event?: string; data?: Record<string, string | undefined> } | null = null;
  try { d = typeof data === "string" ? JSON.parse(data) : (data as typeof d); } catch { return null; }
  if (!d || typeof d !== "object" || d.type !== "WA_EMBEDDED_SIGNUP") return null;
  const ev = String(d.event ?? "");
  // FINISH, plus FINISH_ONLY_WABA and FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING (a number already on the business app).
  if (ev.startsWith("FINISH")) {
    const phoneNumberId = d.data?.phone_number_id ?? "";
    const wabaId = d.data?.waba_id ?? "";
    return phoneNumberId && wabaId ? { kind: "finish", phoneNumberId, wabaId } : { kind: "error", message: null };
  }
  if (ev === "CANCEL") return { kind: "cancel", step: d.data?.current_step ?? null };
  if (ev === "ERROR") return { kind: "error", message: d.data?.error_message ?? null };
  return null;
}

/** Plain words for each way connecting can fail. */
export function connectErrorCopy(code: string, detail?: string | null): string {
  switch (code) {
    case "sdk_failed": return "Couldn't load the Facebook sign in. Check your connection, or turn off any blocker for facebook.com, and try again.";
    case "sdk_timeout": return "The Facebook sign in took too long to load. Try again.";
    case "cancelled": return "Setup was closed before it finished. Nothing was connected.";
    case "no_code": return "Facebook didn't confirm the sign in. Try again, and finish every step in the window.";
    case "no_number": return "Facebook didn't send the WhatsApp number. Try again and pick a number on the last step.";
    case "meta_error": return detail ? `Facebook stopped the setup: ${detail}` : "Facebook stopped the setup. Try again in a minute.";
    default: return detail || "Couldn't connect WhatsApp. Try again.";
  }
}

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const sizeLabel = (n: number) => n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
/** The plain error for a file over the limit, or null. */
export function fileTooBig(name: string, size: number): string | null {
  return size > MAX_FILE_BYTES ? `${name} is ${sizeLabel(size)}. Files can be up to 5 MB.` : null;
}
