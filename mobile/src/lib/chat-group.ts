import type { ChatMessage } from "@/api/types";

/**
 * R35: how a conversation reads like a native messenger. Messages from the same person a few
 * minutes apart group under one name and avatar; a day line separates days ("Today", "Yesterday",
 * "Monday 20 October").
 */
export type ChatItem = { kind: "day"; id: string; label: string } | { kind: "msg"; id: string; m: ChatMessage; grouped: boolean };

export const GROUP_GAP_MS = 5 * 60_000;
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** The day line's words for a date, seen from now. */
export function dayLabel(d: Date, now = new Date()): string {
  if (dayKey(d) === dayKey(now)) return "Today";
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (dayKey(d) === dayKey(y)) return "Yesterday";
  const base = `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/** Oldest first in, oldest first out, with day lines and grouping marks. */
export function groupMessages(messages: ChatMessage[], now = new Date()): ChatItem[] {
  const out: ChatItem[] = [];
  let prev: ChatMessage | null = null;
  let lastDay = "";
  for (const m of messages) {
    const at = new Date(m.createdAt);
    const key = Number.isNaN(at.getTime()) ? lastDay : dayKey(at);
    if (key && key !== lastDay) {
      out.push({ kind: "day", id: `day:${key}`, label: dayLabel(at, now) });
      lastDay = key;
      prev = null;
    }
    const grouped = !!prev && !prev.deleted && !m.deleted && prev.author.id === m.author.id
      && at.getTime() - new Date(prev.createdAt).getTime() < GROUP_GAP_MS;
    out.push({ kind: "msg", id: m.id, m, grouped });
    prev = m;
  }
  return out;
}
