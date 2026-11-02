/** R126 People: query keys and reads for the staff directory, profiles, away, onboarding and assets (/api/people). */
import { api } from "@/web/lib/api";
import type { Asset, AssetEvent, AwayEntry, OnboardingTemplate, RunProgress, StaffPerson } from "@/shared/people-r126";

export const pk = {
  staff: ["people-r126", "staff"] as const,
  profile: (id: string) => ["people-r126", "profile", id] as const,
  away: (from: string, to: string) => ["people-r126", "away", from, to] as const,
  templates: ["people-r126", "templates"] as const,
  assets: ["people-r126", "assets"] as const,
  asset: (id: string) => ["people-r126", "asset", id] as const,
};

export type StaffList = { people: StaffPerson[]; me: string; isAdmin: boolean };
export type Profile = {
  person: StaffPerson; manager: { userId: string; name: string; title: string } | null; reports: { userId: string; name: string; title: string }[];
  away: AwayEntry[]; runs: RunProgress[]; assets: Asset[]; canEdit: boolean; canAdmin: boolean;
};
export type AssetView = { asset: Asset; history: AssetEvent[]; canEdit: boolean };

export const getStaff = () => api.get<StaffList>("/people/staff");
export const getProfile = (id: string) => api.get<Profile>(`/people/staff/${encodeURIComponent(id)}`);
export const getAway = (from: string, to: string) => api.get<{ away: AwayEntry[] }>(`/people/away?from=${from}&to=${to}`);
export const getTemplates = () => api.get<{ templates: OnboardingTemplate[] }>("/people/templates");
export const getAssets = () => api.get<{ assets: Asset[] }>("/people/assets");
export const getAsset = (id: string) => api.get<AssetView>(`/people/assets/${encodeURIComponent(id)}`);

export const todayYmd = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
export const fmtDate = (ymd: string | null | undefined) => {
  if (!ymd) return "";
  const d = new Date(`${ymd}T00:00:00`);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};
export const money = (cents: number | null) => (cents == null ? "" : (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
export const assetUrl = (id: string) => `${window.location.origin}/app/contacts/assets/${encodeURIComponent(id)}`;
