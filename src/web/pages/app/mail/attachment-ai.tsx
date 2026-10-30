/**
 * Tools P2 H3: AI helper entries in a mail attachment's Tools menu. Mounted only while the menu is open, so the
 * Tools catalogue (features on for this deployment) is fetched on first open and then reused from the cache.
 */
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { api } from "@/web/lib/api";
import { MenuItem, MenuLabel } from "@/web/components/ui/menu";
import type { ToolsInfo } from "@/shared/tools";

const ENTRIES = [
  { feature: "ask", label: "Ask this document", takes: /\.(pdf|docx|png|jpe?g)$/i },
  { feature: "translate", label: "Translate", takes: /\.(pdf|docx)$/i },
  { feature: "extract", label: "Invoice to a sheet", takes: /\.(pdf|png|jpe?g)$/i },
  { feature: "contracts", label: "Contract dates", takes: /\.(pdf|docx)$/i },
] as const;

export function AttachmentAiItems({ id, filename }: { id: string; filename: string }) {
  const navigate = useNavigate();
  const info = useQuery({ queryKey: ["tools"], queryFn: () => api.get<ToolsInfo>("/tools"), staleTime: 5 * 60_000 });
  const on = new Set(info.data?.features ?? []);
  const items = ENTRIES.filter((e) => on.has(e.feature) && e.takes.test(filename));
  if (items.length === 0) return null;
  return (
    <>
      <MenuLabel>AI helpers</MenuLabel>
      {items.map((e) => (
        <MenuItem key={e.feature} onSelect={() => navigate(`/app/tools/ai?feature=${e.feature}&attachment=${encodeURIComponent(id)}&name=${encodeURIComponent(filename)}`)}>{e.label}</MenuItem>
      ))}
    </>
  );
}
