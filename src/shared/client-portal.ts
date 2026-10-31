/**
 * R120: client portal. A login free space per contact or company: shared files, docs and tasks, file requests (R88)
 * and a messages thread. Clients sign in with a one time email link; their session is scoped to one portal.
 */
export const PORTAL_LINK_MINUTES = 15;
export const PORTAL_SESSION_DAYS = 30;
export const PORTAL_FILE_KEEP_DAYS = 365;
export const PORTAL_MAX_PEOPLE = 25;
export const PORTAL_MAX_ITEMS = 300;
export const PORTAL_MESSAGE_MAX = 4000;
export const PORTAL_LINKS_PER_HOUR = 5;
export const PORTAL_MAIL_EVERY_MS = 15 * 60_000;

export type PortalItemKind = "file" | "doc" | "task" | "request";
export type PortalTaskState = "todo" | "doing" | "done";

export interface PortalSummary {
  id: string; name: string; url: string;
  contact: { id: string; name: string } | null; company: { id: string; name: string } | null;
  people: number; unread: boolean; lastActivityAt: string; archived: boolean; mine: boolean;
}
export interface PortalPerson { id: string; email: string; name: string | null; lastSeenAt: string | null; addedAt: string }
export interface PortalItem {
  id: string; kind: PortalItemKind; refId: string; title: string; folder: string | null; bytes: number | null; addedAt: string;
  /** Tasks: the task's state now and its due date. */
  state?: PortalTaskState | null; due?: string | null;
  /** File requests: open or closed and how many files came in. */
  open?: boolean; received?: number;
  /** False when the doc, task or request behind it was deleted. */
  live: boolean;
}
export interface PortalMessage { id: string; fromClient: boolean; author: string; body: string; at: string }
export interface PortalDetail {
  portal: PortalSummary & { welcome: string | null; showBrand: boolean };
  people: PortalPerson[]; items: PortalItem[]; messages: PortalMessage[]; canManage: boolean; requestsOn: boolean;
}

export const taskStateLabel = (s: PortalTaskState | null | undefined) => (s === "done" ? "Done" : s === "doing" ? "In progress" : "To do");

/** Folder names are one short line; blank means no folder. */
export function cleanFolder(v: string | null | undefined): string | null {
  // eslint-disable-next-line no-control-regex
  const s = String(v ?? "").replace(/[\u0000-\u001f\u007f/\\]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return s || null;
}

export const emailOk = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;
