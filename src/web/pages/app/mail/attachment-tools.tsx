/**
 * Tools: a short Tools menu beside a mail attachment. The most useful actions for that kind of file come first
 * (at most five), then "More tools" opens the Tools page showing every tool that takes the file. Each action opens
 * with the attachment already chosen, so nothing is downloaded or uploaded again. Shown only when Tools is on.
 * On a phone the menu opens as a sheet from the bottom.
 */
import { useNavigate } from "react-router";
import type { ComponentType } from "react";
import {
  IconCalendarClock, IconChatQuote, IconColumns, IconDocs, IconEyeOff, IconFilePlus, IconFilter, IconGlobe, IconLink, IconMinimize,
  IconPenLine, IconReceipt, IconRefresh, IconSearch, IconWrench, IconCamera,
} from "@/web/components/ui/icon";
import { Menu, MenuItem, MenuLabel } from "@/web/components/ui/menu";
import { useConfig } from "@/web/lib/queries";
import { toolsForFile } from "@/shared/tools";
import { useToolFeatureList } from "@/web/components/tools/use-tools-info"; // Tools P2
import { middleTruncate, warmEngine } from "@/web/components/tools/tool-directory";

type Action = { key: string; label: string; icon: ComponentType<{ className?: string }>; to: string };

/** The best few actions for a file, most useful first. Exported for tests. */
export function attachmentActions(filename: string, features: readonly string[], q: string): Action[] {
  const on = (f: string) => features.includes(f);
  const tools = new Map(toolsForFile(filename, features).map((t) => [t.op, t]));
  const tool = (op: string, icon: Action["icon"]): Action | null => { const t = tools.get(op as never); return t ? { key: op, label: t.label, icon, to: `/app/tools?op=${op}&${q}` } : null; };
  const page = (key: string, ok: boolean, label: string, icon: Action["icon"], to: string): Action | null => (ok ? { key, label, icon, to: `${to}${to.includes("?") ? "&" : "?"}${q}` } : null);
  const pdf = /\.pdf$/i.test(filename), office = /\.(docx|xlsx|pptx|odt|ods|odp)$/i.test(filename), docx = /\.docx$/i.test(filename);
  const image = /\.(png|jpe?g|webp)$/i.test(filename), sheet = /\.(xlsx|xls|csv)$/i.test(filename);
  const list: (Action | null)[] = pdf ? [
    tool("compress", IconMinimize),
    page("organize", on("editor"), "Edit pages", IconColumns, "/app/tools/pages"),
    page("esign", on("esign"), "Sign", IconPenLine, "/app/tools/sign"),
    page("share", on("share"), "Share as a link", IconLink, "/app/tools/share"),
    page("ask", on("ask"), "Ask this document", IconChatQuote, "/app/tools/ai?feature=ask"),
    tool("pdf-to-docx", IconDocs),
    tool("ocr", IconSearch),
    tool("redact", IconEyeOff),
  ] : office || sheet ? [
    tool("convert", IconRefresh),
    sheet ? tool("excel-clean", IconFilter) : null,
    page("share", on("share"), "Share as a link", IconLink, "/app/tools/share"),
    docx ? page("ask", on("ask"), "Ask this document", IconChatQuote, "/app/tools/ai?feature=ask") : null,
    docx ? page("translate", on("translate"), "Translate", IconGlobe, "/app/tools/ai?feature=translate") : null,
    docx ? page("contracts", on("contracts"), "Contract dates", IconCalendarClock, "/app/tools/ai?feature=contracts") : null,
  ] : image ? [
    tool("images-to-pdf", IconFilePlus),
    tool("scan-clean", IconCamera),
    page("extract", on("extract"), "Invoice to a sheet", IconReceipt, "/app/tools/ai?feature=extract"),
    page("ask", on("ask"), "Ask this document", IconChatQuote, "/app/tools/ai?feature=ask"),
    page("share", on("share"), "Share as a link", IconLink, "/app/tools/share"),
  ] : [page("share", on("share"), "Share as a link", IconLink, "/app/tools/share")];
  return list.filter((a): a is Action => !!a).slice(0, 5);
}

export function AttachmentTools({ id, filename, compact }: { id: string; filename: string; compact?: boolean }) {
  const config = useConfig();
  const navigate = useNavigate();
  const features = useToolFeatureList();
  const q = `attachment=${encodeURIComponent(id)}&name=${encodeURIComponent(filename)}`;
  const actions = attachmentActions(filename, features, q);
  const anyTool = toolsForFile(filename, features).length > 0 || /\.pdf$/i.test(filename);
  if (!config.data?.tools || (actions.length === 0 && !anyTool)) return null;
  return (
    <Menu label={`Tools for ${filename}`} align="start" sheet
      trigger={<button type="button" data-testid="attachment-tools" onClick={() => { void warmEngine(); }} className={compact
        ? "inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-xs text-muted hover:text-fg max-sm:min-h-11"
        : "flex h-full items-center gap-1 rounded-lg border border-line bg-elevated px-2.5 py-2 text-xs text-muted hover:border-line-strong hover:text-fg max-sm:min-h-11"}><IconWrench className="h-3.5 w-3.5" />Tools</button>}>
      <MenuLabel><span title={filename}>{middleTruncate(filename, 36)}</span></MenuLabel>
      {actions.map((a) => <MenuItem key={a.key} icon={<a.icon />} onSelect={() => navigate(a.to)}>{a.label}</MenuItem>)}
      {anyTool && (
        <>
          <div className="mx-2 my-1 h-px bg-line" role="separator" />
          <MenuItem icon={<IconWrench />} onSelect={() => navigate(`/app/tools?${q}`)}>More tools</MenuItem>
        </>
      )}
    </Menu>
  );
}
