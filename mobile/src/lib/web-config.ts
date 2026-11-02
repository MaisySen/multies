import { useQuery } from "@tanstack/react-query";
import { useSession } from "./session";

/**
 * M1: the web app's feature flags (GET /api/config), fetched once and kept for the session, so the phone shows a
 * feature only where the web does. Unknown or missing flags read as off. The sample workspace has every M1 flag on.
 */
export interface WebConfig { filesPlus?: boolean; docsPlus?: boolean; searchR98?: boolean; maps?: boolean; mailArchive?: boolean; davSync?: boolean; [k: string]: unknown }

export const SAMPLE_WEB_CONFIG: WebConfig = { filesPlus: true, docsPlus: true, searchR98: true, maps: true, mailArchive: true, davSync: true };

export const webConfigKey = (mode: string) => ["web-config", mode] as const;

export function useWebConfig() {
  const { transport, mode, status } = useSession();
  return useQuery({
    queryKey: webConfigKey(mode),
    enabled: status === "signedIn",
    queryFn: async (): Promise<WebConfig> => (mode === "sample" ? SAMPLE_WEB_CONFIG : (await transport.request<WebConfig>("GET", "/config")) ?? {}),
    staleTime: 10 * 60_000,
    retry: 1,
  });
}
