import type { Api } from "@/api/endpoints";
import type { PushData } from "@/api/types";
import { displayName } from "./format";
import { dueLabel } from "./tasks";

/**
 * Pushes from the MyMail server carry only an event type and an id, never any mail or task text,
 * so nothing private passes through Apple, Google or Expo. The app fetches the item itself and
 * writes the notification on the phone.
 */

/** Pulls { type, id } out of whatever shape the push arrived in (FCM, APNs, a tapped notification). */
export function extractPushData(raw: unknown): PushData | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.type === "string" && typeof o.id === "string") return { type: o.type, id: o.id };
  if (typeof o.dataString === "string") {
    try { return extractPushData(JSON.parse(o.dataString)); } catch { return null; }
  }
  for (const k of ["data", "body", "notification", "request", "content", "trigger", "payload"]) {
    const hit = extractPushData(o[k]);
    if (hit) return hit;
  }
  return null;
}

/** The screen a push opens. */
export function routeForPush(d: PushData): string | null {
  const id = encodeURIComponent(d.id);
  if (d.type === "message.received") return `/thread/${id}`;
  if (d.type === "approval.requested") return d.id ? `/approval/${id}` : "/approvals";
  if (d.type.startsWith("task.")) return `/task/${id}`;
  if (d.type === "automation.email" && d.id.startsWith("msg_")) return `/thread/${id}`;
  return null;
}

export interface PushText { title: string; body: string; channel: "mail" | "approvals" | "tasks" }

export function channelFor(type: string): PushText["channel"] {
  return type.startsWith("approval") ? "approvals" : type.startsWith("message") || type.startsWith("mail") ? "mail" : "tasks";
}

/** What to say when the item can't be fetched (offline, signed out, or deleted since). */
export function fallbackText(type: string): PushText {
  const channel = channelFor(type);
  switch (type) {
    case "message.received": return { title: "New email", body: "Tap to read it.", channel };
    case "approval.requested": return { title: "An agent wants to send a message", body: "Tap to review.", channel };
    case "task.assigned": return { title: "A task was assigned to you", body: "Tap to open it.", channel };
    case "task.commented": return { title: "New comment on a task", body: "Tap to read it.", channel };
    case "task.email_reply": return { title: "New reply on a task's email", body: "Tap to open the task.", channel };
    case "task.due_soon": return { title: "A task is due soon", body: "Tap to open it.", channel };
    case "automation.email": return { title: "An automation sent an email", body: "Tap to see it.", channel };
    case "automation.status": return { title: "An automation needs a look", body: "Open MyMail on the web to check it.", channel };
    default: return { title: "MyMail", body: "Something new is waiting for you.", channel };
  }
}

const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 3).trimEnd()}...` : s);

/** Fetches the item a push is about and words the notification. Never throws. */
export async function describePush(api: Api | null, d: PushData): Promise<PushText> {
  const base = fallbackText(d.type);
  if (!api || !d.id) return base;
  try {
    if (d.type === "message.received" || (d.type === "automation.email" && d.id.startsWith("msg_"))) {
      const { message: m } = await api.message(d.id);
      return { ...base, title: d.type === "message.received" ? `New email from ${displayName(m.from)}` : base.title, body: clip(m.subject || m.snippet || base.body) };
    }
    if (d.type === "approval.requested") {
      const { approvals } = await api.approvals("pending");
      const a = approvals.find((x) => x.id === d.id);
      if (!a) return base;
      return { ...base, body: clip(`"${a.subject}" to ${a.to[0] ?? "a customer"}. Tap to review.`) };
    }
    if (d.type.startsWith("task.")) {
      const detail = await api.task(d.id);
      const t = detail.task;
      const name = `${t.ref}: ${t.title}`;
      if (d.type === "task.assigned") return { ...base, title: "Assigned to you", body: clip(name) };
      if (d.type === "task.commented") {
        const c = detail.comments[detail.comments.length - 1];
        return { ...base, title: `New comment on ${t.ref}`, body: clip(c ? `${c.author.name ?? "Someone"}: ${c.body}` : t.title) };
      }
      if (d.type === "task.email_reply") {
        const r = detail.thread[detail.thread.length - 1];
        return { ...base, title: `New reply on ${t.ref}`, body: clip(r ? `${displayName(r.from)}: ${r.latestText}` : t.title) };
      }
      if (d.type === "task.due_soon") return { ...base, title: dueLabel(t.due)?.text ?? "Due soon", body: clip(name) };
      return { ...base, body: clip(name) };
    }
  } catch {
    return base;
  }
  return base;
}
