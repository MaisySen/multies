/**
 * M2 (1.10.10): Deals on the phone, the web's Contacts > Deals (GET /api/deals, PATCH /api/deals/:id). Pure helpers.
 */
export type DealStage = "lead" | "qualified" | "proposal" | "won" | "lost";
export interface Deal {
  id: string; title: string; stage: DealStage; value: number; currency: string; probability?: number; expectedClose?: string | null;
  closeReason?: string | null; closedAt?: string | null; updatedAt?: string; version?: number;
  contact?: { id: string; name?: string | null; email?: string | null } | null; company?: { id: string; name: string } | null;
}
export interface DealsResponse { stages: { id: DealStage; name: string; total: number }[]; deals: Deal[] }

export const STAGE_ORDER: DealStage[] = ["lead", "qualified", "proposal", "won", "lost"];
export const STAGE_LABEL: Record<DealStage, string> = { lead: "Lead", qualified: "Qualified", proposal: "Proposal", won: "Won", lost: "Lost" };

export function money(v: number, currency = "AUD"): string {
  try { return new Intl.NumberFormat("en-AU", { style: "currency", currency, maximumFractionDigits: v % 1 === 0 ? 0 : 2 }).format(v); }
  catch { return `${currency} ${Math.round(v)}`; }
}

/** Stages in order, each with its deals and total; empty stages stay so the pipeline reads the same as the web. */
export function byStage(r: DealsResponse | undefined, filter = "") {
  const f = filter.trim().toLowerCase();
  const deals = (r?.deals ?? []).filter((d) => !f || [d.title, d.contact?.name, d.company?.name].some((x) => x?.toLowerCase().includes(f)));
  return STAGE_ORDER.map((id) => {
    const items = deals.filter((d) => d.stage === id);
    return { id, name: r?.stages.find((s) => s.id === id)?.name ?? STAGE_LABEL[id], total: items.reduce((n, d) => n + (d.value || 0), 0), items };
  });
}

/** One plain line under a deal's title: who and with which company. */
export const dealLine = (d: Deal) => [d.contact?.name || d.contact?.email, d.company?.name].filter(Boolean).join(", ");

/** Open pipeline: what is not won or lost, and its chance weighted forecast. */
export function pipeline(r: DealsResponse | undefined) {
  const open = (r?.deals ?? []).filter((d) => d.stage !== "won" && d.stage !== "lost");
  return { count: open.length, value: open.reduce((n, d) => n + d.value, 0), forecast: Math.round(open.reduce((n, d) => n + d.value * ((d.probability ?? 0) / 100), 0)) };
}
