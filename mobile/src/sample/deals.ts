/**
 * M2 (1.10.10): the sample workspace's deals (GET /api/deals, PATCH /api/deals/:id), the same shape as the web.
 */
import { ApiError } from "@/api/errors";
import type { Deal, DealsResponse, DealStage } from "@/lib/deals";
import { STAGE_LABEL, STAGE_ORDER } from "@/lib/deals";

const day = 86_400_000;
export function sampleDeals(now = Date.now()): Deal[] {
  const d = (id: string, title: string, stage: DealStage, value: number, probability: number, contact: Deal["contact"], company: Deal["company"], closeIn: number | null): Deal => ({
    id, title, stage, value, currency: "AUD", probability, contact, company, expectedClose: closeIn === null ? null : new Date(now + closeIn * day).toISOString(),
    closeReason: null, closedAt: stage === "won" || stage === "lost" ? new Date(now - 3 * day).toISOString() : null, version: 1,
  });
  const priya = { id: "con_s1", name: "Priya Raman", email: "priya@harbourbuild.com.au" }, tom = { id: "con_s2", name: "Tom Nguyen", email: "tom@greenleaf.au" };
  const hb = { id: "co_s1", name: "Harbour Build" }, gl = { id: "co_s2", name: "Greenleaf Cafe" };
  return [
    d("del_s1", "Site office fit out", "lead", 18500, 10, priya, hb, 30),
    d("del_s2", "Cafe loyalty emails", "qualified", 4200, 30, tom, gl, 14),
    d("del_s3", "Harbour Build support plan", "proposal", 26000, 60, priya, hb, 7),
    d("del_s4", "Menu boards", "won", 2900, 100, tom, gl, null),
    d("del_s5", "Tender pack design", "lost", 7500, 0, null, hb, null),
  ];
}

export function dealsRoute(store: { deals: Deal[] }, method: string, path: string, body: unknown): unknown {
  if (path !== "/deals" && !path.startsWith("/deals/")) return undefined;
  if (method === "GET" && path === "/deals") {
    return { stages: STAGE_ORDER.map((id) => ({ id, name: STAGE_LABEL[id], total: store.deals.filter((x) => x.stage === id).reduce((n, x) => n + x.value, 0) })), deals: store.deals } satisfies DealsResponse;
  }
  const id = decodeURIComponent(path.slice("/deals/".length));
  if (method === "PATCH" && id) {
    const deal = store.deals.find((x) => x.id === id);
    if (!deal) throw new ApiError(404, "not_found", "Deal not found.");
    const stage = (body as { stage?: DealStage } | null)?.stage;
    if (stage && STAGE_ORDER.includes(stage)) Object.assign(deal, { stage, probability: stage === "won" ? 100 : stage === "lost" ? 0 : deal.probability, version: (deal.version ?? 1) + 1 });
    return { deal };
  }
  return undefined;
}
