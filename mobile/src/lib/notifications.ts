import type { AppNotification, NotificationSettings } from "@/api/types";
import type { IconName } from "@/components/ui";

/** The inbox filter chips, in order. `category` is what GET /api/notifications?category= takes. */
export const NOTIFICATION_FILTERS: { id: string; label: string; category?: string }[] = [
  { id: "all", label: "All" },
  { id: "mention", label: "Mentions", category: "mention" },
  { id: "assignment", label: "Assigned", category: "assignment" },
  { id: "comment", label: "Comments", category: "comment" },
  { id: "approval", label: "Approvals", category: "approval" },
  { id: "due_soon", label: "Due soon", category: "due_soon" },
  { id: "chat", label: "Chat", category: "chat" },
];

/** Names for the settings screen, in the order shown. Categories the server adds later show by their key. */
export const CATEGORY_LABELS: Record<string, { label: string; hint: string }> = {
  mention: { label: "Mentions", hint: "Someone writes @ your name in chat or a comment" },
  assignment: { label: "Assigned to you", hint: "A task is given to you" },
  comment: { label: "Comments", hint: "New comments on tasks you follow" },
  approval: { label: "Approvals", hint: "An agent asks to send a message" },
  due_soon: { label: "Due soon", hint: "Your tasks that are close to their due date" },
  chat: { label: "Chat messages", hint: "Direct messages and thread replies" },
  email: { label: "Email", hint: "New mail in your inboxes" },
  status: { label: "Status changes", hint: "Tasks you follow change status" },
};

export function orderedCategories(s: NotificationSettings): string[] {
  const known = Object.keys(CATEGORY_LABELS).filter((k) => k in s);
  return [...known, ...Object.keys(s).filter((k) => !(k in CATEGORY_LABELS)).sort()];
}

export function categoryIcon(category: string | undefined): IconName {
  switch (category) {
    case "mention": return "at-sign";
    case "assignment": return "user-check";
    case "comment": return "message-square";
    case "approval": return "check-circle";
    case "due_soon": return "clock";
    case "chat": return "message-circle";
    case "email": return "mail";
    case "status": return "activity";
    default: return "bell";
  }
}

/** Unread first, then newest first. */
export function sortNotifications(list: AppNotification[]): AppNotification[] {
  return [...list].sort((a, b) => Number(a.read) - Number(b.read) || b.createdAt.localeCompare(a.createdAt));
}

export type NotificationTarget =
  | { kind: "route"; href: { pathname: string; params?: Record<string, string> } }
  | { kind: "web"; url: string }
  | { kind: "none" };

/**
 * Where tapping a notification goes. A chat message opens through /chat/message/[id], which looks
 * the message up and opens its channel (and its thread). Goals have no phone screen yet, so they
 * open on the web.
 */
export function notificationTarget(n: AppNotification, webBase: string): NotificationTarget {
  const id = n.entityId;
  if (id) {
    switch (n.entityType) {
      case "task": return { kind: "route", href: { pathname: "/task/[id]", params: { id } } };
      case "chat_message": return { kind: "route", href: { pathname: "/chat/message/[id]", params: { id } } };
      case "approval": return { kind: "route", href: { pathname: "/approval/[id]", params: { id } } };
      case "message": return { kind: "route", href: { pathname: "/thread/[id]", params: { id } } };
    }
  }
  if (n.link && n.link.startsWith("/")) return { kind: "web", url: `${webBase}${n.link}` };
  return { kind: "none" };
}
