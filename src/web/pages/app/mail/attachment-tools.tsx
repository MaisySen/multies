/**
 * Tools P1: a small Tools menu beside a mail attachment. It lists the tools that take that file and opens
 * the Tools page with the attachment already chosen, so nothing is downloaded or uploaded again.
 * Shown only when the server has Tools on.
 */
import { useNavigate } from "react-router";
import { IconWrench } from "@/web/components/ui/icon";
import { Menu, MenuItem, MenuLabel } from "@/web/components/ui/menu";
import { useConfig } from "@/web/lib/queries";
import { toolsForFile } from "@/shared/tools";

export function AttachmentTools({ id, filename, compact }: { id: string; filename: string; compact?: boolean }) {
  const config = useConfig();
  const navigate = useNavigate();
  const tools = toolsForFile(filename);
  if (!config.data?.tools || tools.length === 0) return null;
  return (
    <Menu label={`Tools for ${filename}`} align="start"
      trigger={<button type="button" data-testid="attachment-tools" className={compact
        ? "inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-xs text-muted hover:text-fg max-sm:min-h-11"
        : "flex h-full items-center gap-1 rounded-lg border border-line bg-elevated px-2.5 py-2 text-xs text-muted hover:border-line-strong hover:text-fg max-sm:min-h-11"}><IconWrench className="h-3.5 w-3.5" />Tools</button>}>
      <MenuLabel>{filename}</MenuLabel>
      {tools.map((t) => (
        <MenuItem key={t.op} onSelect={() => navigate(`/app/tools?op=${t.op}&attachment=${encodeURIComponent(id)}&name=${encodeURIComponent(filename)}`)}>{t.label}</MenuItem>
      ))}
    </Menu>
  );
}
