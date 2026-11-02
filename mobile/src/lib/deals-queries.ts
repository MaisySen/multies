/**
 * M2 (1.10.10): React Query hooks for Deals. Nothing is kept on the phone; the list answers from the server.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "./session";
import { noAccess, notFoundErr } from "./contacts-queries";
import type { Deal, DealsResponse, DealStage } from "./deals";

export const dealKeys = { all: ["deals"] as const };
const retry = (k: number, e: unknown) => !noAccess(e) && !notFoundErr(e) && k < 2;

export function useDeals() {
  const { transport, mode } = useSession();
  return useQuery({ queryKey: [...dealKeys.all, mode], retry, queryFn: () => transport.request<DealsResponse>("GET", "/deals") });
}

export function useMoveDeal() {
  const { transport, mode } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, stage }: { id: string; stage: DealStage }) => transport.request<{ deal: Deal }>("PATCH", `/deals/${encodeURIComponent(id)}`, { stage }),
    onSuccess: ({ deal }) => {
      qc.setQueryData<DealsResponse>([...dealKeys.all, mode], (old) => old ? { ...old, deals: old.deals.map((d) => (d.id === deal.id ? { ...d, ...deal } : d)) } : old);
      qc.invalidateQueries({ queryKey: dealKeys.all });
    },
  });
}
