/**
 * M1 (1.10.9): the web app's feature flags (GET /api/config), read once and kept for five minutes, so a phone screen
 * shows only what the web shows. A server that does not answer (offline, older server) counts every flag as off.
 */
import { useQuery } from "@tanstack/react-query";
import { useSession } from "./session";

export interface WebConfig {
  maps?: boolean; mailArchive?: boolean; davSync?: boolean; filesPlus?: boolean; docsPlus?: boolean; searchR98?: boolean;
  mergePlus?: boolean; [key: string]: unknown;
}

export const webConfigKey = ["web-config"] as const;

/** True only when the flag is exactly true. */
export function flagOn(c: WebConfig | null | undefined, name: string): boolean { return !!c && c[name] === true; }

export function useWebConfig() {
  const { api, transport, status } = useSession();
  void api;
  return useQuery({
    queryKey: webConfigKey,
    enabled: status === "signedIn",
    queryFn: async (): Promise<WebConfig> => {
      try { return ((await transport.request<WebConfig>("GET", "/config")) ?? {}) as WebConfig; } catch { return {}; }
    },
    staleTime: 5 * 60_000,
  });
}
