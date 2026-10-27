/** R35 moderation queue badge, in its own module since R45 (MB-203): the app frame reads it on every page, and importing
 * it from the moderation page pulled that page, its report reasons and its dialogs into the frame's first load. */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/web/lib/api";

export function useOpenReportCount(enabled: boolean) {
  return useQuery({ queryKey: ["admin", "reports", "count"], enabled, refetchInterval: 120_000, queryFn: async () => (await api.get<{ open: number }>("/admin/reports/count")).open });
}
