/**
 * Tools P2: the deployment's Tools catalogue and features (GET /api/tools), cached for 10 minutes and shared by the
 * attachment Tools menu, the batch bar and the Tools page, so a thread with many attachments asks once.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { useConfig } from "@/web/lib/queries";
import type { ToolsInfo } from "@/shared/tools";

export function useToolsInfo(enabled = true) {
  const config = useConfig();
  return useQuery({ queryKey: ["tools"], enabled: enabled && !!config.data?.tools, staleTime: 10 * 60_000, queryFn: () => api.get<ToolsInfo>("/tools") });
}

/** The P2 features on here; empty until GET /api/tools answers (P1 tools need none). */
export function useToolFeatureList(enabled = true): string[] {
  return useToolsInfo(enabled).data?.features ?? [];
}
