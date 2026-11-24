/**
 * Round 2 (PR 24): Settings, Workspace: "AI and API tasks always wait in Triage" (admins; off by default). When on,
 * a task an API key, an AI agent or a connected AI app makes waits in Triage in every project.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Switch } from "@/web/components/ui/misc";
import { useMe } from "@/web/lib/queries";
import { tr } from "@/web/i18n";

export const TRIAGE_SETTINGS_KEY = ["triage-settings"] as const;

export function TriageAlwaysSetting() {
  const role = useMe().data?.organization?.role;
  const canEdit = role === "owner" || role === "admin";
  const q = useQuery({ queryKey: TRIAGE_SETTINGS_KEY, queryFn: () => api.get<{ machineTasksAlwaysWait: boolean }>("/triage/settings") });
  const qc = useQueryClient();
  const set = async (v: boolean) => {
    try { await api.put("/triage/settings", { machineTasksAlwaysWait: v }); await qc.invalidateQueries({ queryKey: TRIAGE_SETTINGS_KEY }); } catch (e) { showError(e as Error); }
  };
  return (
    <div className="flex items-center gap-3" data-testid="triage-always-setting">
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-medium">{tr("settings.triage_machine_always")}</p>
        <p className="text-[12.5px] text-muted">{tr("settings.triage_machine_always_hint")}</p>
      </div>
      <Switch checked={q.data?.machineTasksAlwaysWait ?? false} onChange={(v) => void set(v)} label={tr("settings.triage_machine_always")} disabled={!canEdit || !q.data} />
    </div>
  );
}
