/**
 * SOC1: several Pages and accounts per network (flag SOCIAL_MULTI_SOC1), the pure parts shared by the server and the
 * web app. A chosen Page posts as its own account id: fbpage_<Page id> or liorg_<organization id>.
 */
export const SOC1_PAGE_KEY = /^(fbpage|liorg)_[\w.-]{1,64}$/;
export type Soc1App = "facebook" | "linkedin";
export const soc1KeyOf = (app: Soc1App, pageId: string) => `${app === "facebook" ? "fbpage" : "liorg"}_${pageId}`;
export const isPageKey = (id: string) => SOC1_PAGE_KEY.test(id);

export interface Soc1PageView { key: string; app: Soc1App; pageId: string; name: string; pictureUrl: string | null; viaAccountId: string; state: "ok" | "lost" }
export interface Soc1AvailablePage { id: string; name: string; pictureUrl: string | null; canPost: boolean; added: boolean; addedElsewhere: boolean }
export interface Soc1AvailableView { accountId: string; app: Soc1App; needsApproval: boolean; truncated: boolean; pages: Soc1AvailablePage[]; lost: Soc1PageView[] }

export const SOC1_COPY = {
  orgNeedsApproval: "Company Pages need LinkedIn approval",
  orgNeedsApprovalLong: "Your personal profile posts now. Company Pages need LinkedIn approval for page access.",
  pageLost: "Lost permission for this Page. Reconnect Facebook to post here again.",
  noPagesYet: "No Pages chosen yet",
  noPagesFound: "No Pages found for this login. Pages you manage on Facebook show here.",
} as const;

/** Filters Pages by a search (case and accent blind), keeping the order. */
export function filterPages<T extends { name: string }>(pages: T[], q: string): T[] {
  const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const n = norm(q.trim());
  return n ? pages.filter((p) => norm(p.name).includes(n)) : pages;
}

/** The composer remembers each person's last choice in this browser (no server read). */
export const soc1ChoiceKey = (orgId: string, userId: string) => `multies.social.lastTargets.${orgId}.${userId}`;
