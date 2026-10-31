import { Linking, Platform, Share } from "react-native";
import * as Clipboard from "expo-clipboard";
import { linkSegments } from "./mail-body";
import { success, thud, warning } from "./haptics";

/**
 * 1.10.7: the small native things. Copy, Copy link, Share and Translate from a long press on a mail, a post or a
 * link, with a "Copied" toast and a haptic. Uses only what the store builds already carry: expo-clipboard,
 * expo-haptics and React Native's own Share and Linking (no new native module, so it ships over the air).
 */

// ---------------------------------------------------------------- the toast

export interface QuickToast { id: number; text: string; tone: "ok" | "bad" }
let toast: QuickToast | null = null;
let seq = 0;
const toastListeners = new Set<() => void>();
const emitToast = () => toastListeners.forEach((l) => l());
export function showQuickToast(text: string, tone: QuickToast["tone"] = "ok") { toast = { id: ++seq, text, tone }; emitToast(); }
export function clearQuickToast(id?: number) { if (!toast || (id !== undefined && toast.id !== id)) return; toast = null; emitToast(); }
export const currentQuickToast = () => toast;
export function subscribeQuickToast(l: () => void) { toastListeners.add(l); return () => { toastListeners.delete(l); }; }

// ---------------------------------------------------------------- the sheet

export type QuickActionId = "open" | "copy-text" | "copy-link" | "share" | "translate" | "open-link";
export interface QuickTarget {
  /** The sheet's title, e.g. the subject or "Link". */
  title: string;
  subtitle?: string;
  /** The words Copy text, Share and Translate use. */
  text?: string;
  /** A web address for Copy link (and Open on a link). */
  link?: string | null;
  /** What Copy link is called here: "Copy link" or "Copy post link". */
  linkLabel?: string;
  /** A link sheet: Open, Copy link, Share. */
  kind?: "content" | "link";
}
let target: QuickTarget | null = null;
const sheetListeners = new Set<() => void>();
export function openQuickActions(t: QuickTarget) { thud(); target = t; sheetListeners.forEach((l) => l()); }
export function closeQuickActions() { target = null; sheetListeners.forEach((l) => l()); }
export const currentQuickTarget = () => target;
export function subscribeQuickTarget(l: () => void) { sheetListeners.add(l); return () => { sheetListeners.delete(l); }; }
/** A long press on a link in a mail or a post. */
export const openLinkActions = (url: string) => openQuickActions({ kind: "link", title: "Link", subtitle: displayUrl(url), link: url, text: url });

/** The rows of the sheet for a target, in the order a phone's own menus use. */
export function quickOptions(t: QuickTarget): { id: QuickActionId; label: string }[] {
  if (t.kind === "link") {
    const mail = /^mailto:/i.test(t.link ?? "");
    return [
      { id: "open-link", label: mail ? "Write an email" : "Open" },
      { id: "copy-link", label: mail ? "Copy address" : "Copy link" },
      { id: "share", label: "Share" },
    ];
  }
  const out: { id: QuickActionId; label: string }[] = [];
  if (t.text?.trim()) out.push({ id: "copy-text", label: "Copy text" });
  if (t.link) out.push({ id: "copy-link", label: t.linkLabel ?? "Copy link" });
  if (t.text?.trim() || t.link) out.push({ id: "share", label: "Share" });
  if (t.text?.trim()) out.push({ id: "translate", label: "Translate" });
  return out;
}

// ---------------------------------------------------------------- the actions

/** A web or mail address as people read it: no scheme, no trailing slash. */
export function displayUrl(url: string): string {
  return url.replace(/^mailto:/i, "").replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

/** The first web address in some text, if any (mail addresses do not count). */
export function firstLink(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const s of linkSegments(text)) if (s.kind === "link" && /^https?:/i.test(s.url)) return s.url;
  return null;
}

/** Copies to the clipboard, then a haptic and the "Copied" toast. Never throws. */
export async function copyToClipboard(value: string, toastText = "Copied"): Promise<boolean> {
  try {
    await Clipboard.setStringAsync(value);
    success();
    showQuickToast(toastText);
    return true;
  } catch {
    warning();
    showQuickToast("Couldn't copy that", "bad");
    return false;
  }
}

/** The system share sheet with words and or a link. */
export async function shareContent(t: { text?: string; link?: string | null; title?: string }): Promise<boolean> {
  const text = t.text?.trim() ?? "";
  const link = t.link ?? "";
  const message = link && !text.includes(link) ? (text ? `${text}\n\n${link}` : link) : text;
  try {
    // iOS shows a link card for url; Android only reads message.
    if (Platform.OS === "ios" && link && !text) await Share.share({ url: link });
    else await Share.share({ message, title: t.title });
    return true;
  } catch {
    // The web preview has no share sheet in most browsers: copy instead, so the button still does something.
    return copyToClipboard(message, "Copied. Paste it where you want to share it");
  }
}

/**
 * Translate with what the phone already has, never a paid service. Android: the system translate intent (the
 * translate app the phone has answers it), else the share sheet. iOS: the share sheet, where Translate sits beside
 * Copy (text selection in the mail and the post also offers the system Translate).
 */
export async function translateText(text: string): Promise<"intent" | "share" | "copied"> {
  const words = text.trim().slice(0, 5000);
  if (Platform.OS === "android") {
    try {
      await Linking.sendIntent("android.intent.action.TRANSLATE", [{ key: "android.intent.extra.TEXT", value: words }]);
      return "intent";
    } catch { /* no translate app answers it: fall through to the share sheet */ }
  }
  try {
    await Share.share({ message: words, title: "Translate" });
    return "share";
  } catch {
    await copyToClipboard(words, "Copied. Paste it into your translate app");
    return "copied";
  }
}

export async function openLink(url: string) {
  try { await Linking.openURL(url); } catch { warning(); showQuickToast("Couldn't open that link", "bad"); }
}

/** Runs one sheet row for a target. */
export async function runQuickAction(id: QuickActionId, t: QuickTarget) {
  switch (id) {
    case "open":
    case "open-link": if (t.link) await openLink(t.link); return;
    case "copy-text": if (t.text) await copyToClipboard(t.text); return;
    case "copy-link": if (t.link) await copyToClipboard(t.link.replace(/^mailto:/i, ""), /^mailto:/i.test(t.link) ? "Address copied" : "Link copied"); return;
    case "share": await shareContent(t.kind === "link" ? { link: t.link } : { text: t.text, link: t.link, title: t.title }); return;
    case "translate": if (t.text) await translateText(t.text); return;
  }
}
