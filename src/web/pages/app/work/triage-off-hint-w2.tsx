/**
 * Round 2 (PR 24): on /app/triage, admins see the projects that have Triage off, so work from mail rules, forms, keys
 * and AI apps there lands straight on the board. "Turn on" switches one project (PATCH /projects/:id { triage: true }).
 * Nothing changes by itself: no bulk switch, each project is a person's choice.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/web/components/ui/button";
import { Card } from "@/web/components/ui/misc";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { useMe } from "@/web/lib/queries";
import { useProjects } from "./data";

export function TriageOffHint() {
  const role = useMe().data?.organization?.role;
  const isAdmin = role === "owner" || role === "admin";
  const projects = useProjects();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const off = (projects.data ?? []).filter((p) => !p.archived && p.triage === false);
  if (!isAdmin || !off.length) return null;
  const turnOn = async (id: string, name: string) => {
    setBusy(id);
    try {
      await api.patch(`/projects/${id}`, { triage: true });
      await qc.invalidateQueries({ queryKey: ["projects"] });
      toast.success(`Triage is on for ${name}`);
    } catch (e) { showError(e as Error); } finally { setBusy(null); }
  };
  return (
    <Card className="mb-4 p-4" data-testid="triage-off-hint">
      <p className="text-[13.5px] font-medium text-fg">{off.length === 1 ? "1 project has Triage off" : `${off.length} projects have Triage off`}</p>
      <p className="mt-0.5 text-[12.5px] text-muted">Tasks from mail rules, forms, API keys and AI apps go straight onto these boards with nobody checking them first.</p>
      <ul className="mt-3 divide-y divide-line rounded-xl border border-line">
        {off.map((p) => (
          <li key={p.id} className="flex items-center gap-3 px-3 py-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: p.color }} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-[13.5px] text-fg">{p.name}</span>
            <Button size="sm" variant="secondary" onClick={() => void turnOn(p.id, p.name)} loading={busy === p.id} disabled={!!busy} aria-label={`Turn on Triage for ${p.name}`}>Turn on</Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
