/** OPS1: types and calls for the Feature flags section (/api/console/flags; routes/console/flags.ts on the server). */
import { api } from "@/web/lib/api";
import { listQuery, type Page } from "@/web/lib/console-api";
import { FEATURE_FLAGS, type FlagDef, type FlagGroup, type FlagScope } from "@/shared/feature-flags";

export interface FlagGlobal { value: boolean; locked: boolean; note: string | null; updatedBy: string | null; updatedByEmail: string | null; updatedAt: string }

export interface ConsoleFlag {
  key: string; env: string; label: string; description: string; group: FlagGroup; scope: FlagScope; runtime: boolean;
  bootReason: string | null; requires: string[]; envDefault: boolean; globalOverride: FlagGlobal | null;
  workspaceOverrideCount: number; effective: boolean;
}

export interface FlagWorkspaceOverride {
  orgId: string; workspaceName: string | null; value: boolean; note: string | null; updatedByEmail: string | null; updatedAt: string;
  /** False while the setting for everyone is locked: kept, but without effect. */
  applies: boolean;
}

export interface FlagDetail { flag: ConsoleFlag; overrides: Page<FlagWorkspaceOverride> }

export type FlagSource = "default" | "global" | "workspace" | "locked";
export type FlagBlocked = "deploy" | "global_only" | "locked" | null;

export interface WorkspaceFlagRow {
  key: string; label: string; description: string; group: FlagGroup; scope: FlagScope; runtime: boolean; bootReason: string | null;
  envDefault: boolean; global: { value: boolean; locked: boolean } | null; platformValue: boolean;
  workspaceOverride: { value: boolean; note: string | null; updatedAt: string; applies: boolean } | null;
  effective: boolean; source: FlagSource; blocked: FlagBlocked;
}

/** The registry's groups in registry order, for the group chips. */
export const FLAG_GROUPS: FlagGroup[] = [...new Set((FEATURE_FLAGS as readonly FlagDef[]).map((d) => d.group))];

export const GROUP_FILTER = {
  key: "group", label: "Group", initial: "",
  options: [{ value: "", label: "All" }, ...FLAG_GROUPS.map((g) => ({ value: g, label: g }))],
};

const enc = encodeURIComponent;

export const flagsApi = {
  detail: (key: string, cursor?: string | null) => api.get<FlagDetail>(`/console/flags/${enc(key)}${listQuery({ cursor })}`),
  setGlobal: (key: string, body: { value: boolean; locked: boolean; reason: string }) => api.put<{ ok: true }>(`/console/flags/${enc(key)}/global`, body),
  clearGlobal: (key: string, reason: string) => api.del<{ ok: true }>(`/console/flags/${enc(key)}/global`, { reason }),
  setWorkspace: (key: string, orgId: string, body: { value: boolean; reason: string }) => api.put<{ ok: true }>(`/console/flags/${enc(key)}/workspaces/${enc(orgId)}`, body),
  clearWorkspace: (key: string, orgId: string, reason: string) => api.del<{ ok: true }>(`/console/flags/${enc(key)}/workspaces/${enc(orgId)}`, { reason }),
};

export const flagKeys = {
  detail: (key: string) => ["console", "flag", key] as const,
};
