import { useQuery } from "@tanstack/react-query";
import { useSession } from "./session";

/**
 * M1: the web app's feature flags (GET /api/config), fetched once and kept for the session, so the phone shows a
 * feature only where the web does. Unknown or missing flags read as off. The sample workspace has every M1 flag on
 * (a sample transport that answers /config itself can turn one off, which the tests use).
 */
export interface WebConfig {
  filesPlus?: boolean; docsPlus?: boolean; searchR98?: boolean; maps?: boolean; mailArchive?: boolean; davSync?: boolean;
  tools?: boolean; toolFeatures?: string[]; [k: string]: unknown;
}

export const SAMPLE_WEB_CONFIG: WebConfig = {
  filesPlus: true, docsPlus: true, searchR98: true, maps: true, mailArchive: true, davSync: true, tools: true, toolFeatures: ["merge_plus_r109"],
  expenses: true, invoices: true, // M2 (1.10.10)
};

export const webConfigKey = (mode: string) => ["web-config", mode] as const;

/** True only when the flag is exactly true. */
export function flagOn(c: WebConfig | null | undefined, name: string): boolean { return !!c && c[name] === true; }

/** A Tools feature (TOOLS_FEATURES on the web): on only when Tools is on and the feature is listed. */
export function toolFeatureOn(c: WebConfig | null | undefined, feature: string): boolean {
  return flagOn(c, "tools") && Array.isArray(c?.toolFeatures) && c!.toolFeatures.includes(feature);
}

export function useWebConfig() {
  const { transport, mode, status } = useSession();
  return useQuery({
    queryKey: webConfigKey(mode),
    enabled: status === "signedIn",
    queryFn: async (): Promise<WebConfig> => {
      const live = async () => { try { return ((await transport.request<WebConfig>("GET", "/config")) ?? {}) as WebConfig; } catch { return {} as WebConfig; } };
      return mode === "sample" ? { ...SAMPLE_WEB_CONFIG, ...(await live()) } : await live();
    },
    staleTime: 10 * 60_000,
    retry: 1,
  });
}
