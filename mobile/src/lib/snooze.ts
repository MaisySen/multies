/**
 * R31: snooze presets shared by mail and the notifications inbox. The server takes the preset and
 * works out the time in the person's own zone; `snoozeUntil` gives the same answer on the phone for
 * the optimistic row and for the sample workspace.
 */
export type SnoozePreset = "later_today" | "tomorrow" | "next_week";

export const SNOOZE_PRESETS: { id: SnoozePreset; label: string; hint: string }[] = [
  { id: "later_today", label: "Later today", hint: "In 3 hours" },
  { id: "tomorrow", label: "Tomorrow", hint: "8:00 am" },
  { id: "next_week", label: "Next week", hint: "Monday 8:00 am" },
];

const at8 = (d: Date) => { d.setHours(8, 0, 0, 0); return d; };

/** When a preset wakes, in local time. Later today after 6 pm means tomorrow morning. */
export function snoozeUntil(preset: SnoozePreset, now = new Date()): Date {
  const d = new Date(now.getTime());
  if (preset === "later_today") {
    if (now.getHours() >= 18) { d.setDate(d.getDate() + 1); return at8(d); }
    d.setHours(d.getHours() + 3, 0, 0, 0);
    return d;
  }
  if (preset === "tomorrow") { d.setDate(d.getDate() + 1); return at8(d); }
  const day = d.getDay(); // 0 Sunday
  d.setDate(d.getDate() + (((8 - day) % 7) || 7));
  return at8(d);
}

export function snoozeLabel(preset: SnoozePreset): string {
  return SNOOZE_PRESETS.find((p) => p.id === preset)?.label ?? "Later";
}
