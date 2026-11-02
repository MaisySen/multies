/**
 * R126 People (flag PEOPLE_R126): shared shapes and the pure rules the server and the web both use. Staff profiles never
 * hold salary, tax or ID numbers; every field is on a fixed allow list with a length cap.
 */
export const ASSET_KINDS = ["laptop", "phone", "tool", "licence", "other"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
export const ASSET_STATUSES = ["in_use", "in_stock", "repair", "retired", "lost"] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];
export const ASSET_KIND_LABEL: Record<AssetKind, string> = { laptop: "Laptop", phone: "Phone", tool: "Tool", licence: "Licence", other: "Other" };
export const ASSET_STATUS_LABEL: Record<AssetStatus, string> = { in_use: "In use", in_stock: "In stock", repair: "In repair", retired: "Retired", lost: "Lost" };
export const RUN_KINDS = ["onboarding", "offboarding"] as const;
export type RunKind = (typeof RUN_KINDS)[number];
export const ITEM_OWNERS = ["person", "manager", "assigner"] as const;
export type ItemOwner = (typeof ITEM_OWNERS)[number];
export const ITEM_OWNER_LABEL: Record<ItemOwner, string> = { person: "The person", manager: "Their manager", assigner: "Whoever assigns it" };
export const WARRANTY_SOON_DAYS = 60;
export const MAX_ITEMS = 40;
export const MAX_SKILLS = 20;

export interface StaffPerson {
  userId: string; name: string; email: string; image: string | null; role: "owner" | "admin" | "member";
  title: string; team: string; managerUserId: string | null; skills: string[]; startDate: string | null;
  location: string; phone: string; daysOff: number[];
}
export interface AwayEntry { id: string; userId: string; startDate: string; endDate: string; note: string }
export interface TemplateItem { id: string; title: string; offsetDays: number; owner: ItemOwner }
export interface OnboardingTemplate { id: string; kind: RunKind; name: string; items: TemplateItem[]; updatedAt: number }
export interface RunProgress { id: string; templateId: string; kind: RunKind; name: string; startDate: string; done: number; total: number;
  tasks: { itemId: string; taskId: string; title: string; due: string | null; done: boolean; ref?: string }[] }
export interface Asset {
  id: string; tag: string; name: string; kind: AssetKind; serial: string; purchaseDate: string | null; warrantyEnd: string | null;
  valueCents: number | null; status: AssetStatus; assignedUserId: string | null; assignedName?: string | null; notes: string; updatedAt: number;
}
export interface AssetEvent { id: string; action: string; userId: string | null; userName?: string | null; byName: string; detail: string; at: number }

const YMD = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar date in YYYY-MM-DD, or false. */
export function isYmd(s: unknown): s is string {
  if (typeof s !== "string" || !YMD.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
/** Adds whole days to a YYYY-MM-DD date in UTC (no time zone drift). */
export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.trunc(n));
  return d.toISOString().slice(0, 10);
}
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Who owns each checklist item, and when it is due. Manager falls back to the assigner when the person has none. */
export function planRunTasks(items: TemplateItem[], startDate: string, people: { person: string; manager: string | null; assigner: string }) {
  return items.map((it) => ({
    itemId: it.id, title: it.title, due: addDays(startDate, it.offsetDays),
    assigneeUserId: it.owner === "person" ? people.person : it.owner === "manager" ? (people.manager || people.assigner) : people.assigner,
  }));
}

/** Clean list of short tags: trimmed, unique case insensitive, capped. */
export function cleanTags(v: unknown, max = MAX_SKILLS, len = 40): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = []; const seen = new Set<string>();
  for (const x of v) {
    if (typeof x !== "string") continue;
    const t = x.replace(/\s+/g, " ").trim().slice(0, len);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase()); out.push(t);
    if (out.length >= max) break;
  }
  return out;
}
export function cleanDaysOff(v: unknown): number[] {
  if (!Array.isArray(v)) return [0, 6];
  return [...new Set(v.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
}

/** Warranty ended or ending within `days` of today (oldest first). Retired and lost assets are left out. */
export function warrantySoon<T extends { warrantyEnd: string | null; status: string }>(assets: T[], today: string, days = WARRANTY_SOON_DAYS): T[] {
  const until = addDays(today, days);
  return assets.filter((a) => a.warrantyEnd && a.status !== "retired" && a.status !== "lost" && a.warrantyEnd <= until)
    .sort((x, y) => (x.warrantyEnd! < y.warrantyEnd! ? -1 : 1));
}

/** One CSV cell, quoted, with a leading formula character neutralised so a spreadsheet never runs it. */
export function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
export function toCsv(rows: unknown[][]): string { return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n"; }

/** Next asset tag: A-0001 style, one past the highest number in use. */
export function nextAssetTag(tags: string[]): string {
  let max = 0;
  for (const t of tags) { const m = /^A-(\d+)$/.exec(t); if (m) max = Math.max(max, Number(m[1])); }
  return `A-${String(max + 1).padStart(4, "0")}`;
}

/** Simple tree for the org chart: roots are people with no manager (or a manager outside the list, or a loop). */
export function orgTree<T extends { userId: string; managerUserId: string | null }>(people: T[]): { person: T; depth: number }[] {
  const ids = new Set(people.map((p) => p.userId));
  const kids = new Map<string, T[]>();
  const roots: T[] = [];
  for (const p of people) {
    if (p.managerUserId && ids.has(p.managerUserId) && p.managerUserId !== p.userId) {
      const l = kids.get(p.managerUserId) ?? []; l.push(p); kids.set(p.managerUserId, l);
    } else roots.push(p);
  }
  const out: { person: T; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (p: T, depth: number) => {
    if (seen.has(p.userId)) return;
    seen.add(p.userId); out.push({ person: p, depth });
    for (const k of kids.get(p.userId) ?? []) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  // People caught in a manager loop have no root; show them at the top level so nobody disappears.
  for (const p of people) if (!seen.has(p.userId)) walk(p, 0);
  return out;
}

/** True when a manager choice would make a loop (the new manager reports, directly or not, to this person). */
export function makesLoop(people: { userId: string; managerUserId: string | null }[], userId: string, managerId: string | null): boolean {
  if (!managerId) return false;
  if (managerId === userId) return true;
  const by = new Map(people.map((p) => [p.userId, p.managerUserId]));
  let cur: string | null | undefined = managerId; let guard = 0;
  while (cur && guard++ < 500) { if (cur === userId) return true; cur = by.get(cur) ?? null; }
  return false;
}
