/** R87: Links in Tools: queries and small helpers shared by the Links screens. */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import type { BioPageInfo, GoLinkInfo, LinkHostInfo, LinkStats, ShortLinkInfo } from "@/shared/links";

export const linksKey = ["links"] as const;
export function useShortLinks() {
  return useQuery({ queryKey: linksKey, queryFn: () => api.get<{ links: ShortLinkInfo[]; base: string }>("/links"), staleTime: 15_000 });
}
export function useLinkStats(id: string | null, days: number) {
  return useQuery({ queryKey: ["links", id, "stats", days], enabled: !!id, queryFn: () => api.get<LinkStats>(`/links/${id}/stats?days=${days}`), staleTime: 30_000 });
}
export function useBioPage(scope: "workspace" | "me") {
  return useQuery({ queryKey: ["links-bio", scope], queryFn: () => api.get<{ page: BioPageInfo }>(`/links/bio?scope=${scope}`) });
}
export function useGoLinks(enabled = true) {
  return useQuery({ queryKey: ["links-go"], enabled, queryFn: () => api.get<{ links: GoLinkInfo[] }>("/links/go"), staleTime: 60_000 });
}
export function useLinkHost() {
  return useQuery({ queryKey: ["links-host"], queryFn: () => api.get<LinkHostInfo>("/links/host") });
}

export const STATUS: Record<ShortLinkInfo["status"], { label: string; tone: "ok" | "neutral" | "warn" | "bad" }> = {
  active: { label: "Active", tone: "ok" }, off: { label: "Off", tone: "neutral" }, expired: { label: "Ended", tone: "neutral" }, used_up: { label: "Used up", tone: "warn" },
};

/** "harbour.example/menu" from a full address, for tight rows. */
export function shortHost(url: string): string {
  try { const u = new URL(url); return `${u.hostname.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}${u.search ? "?…" : ""}`; } catch { return url; }
}
export const plainUrl = (url: string) => url.replace(/^https?:\/\//, "");

export function compact(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
};
