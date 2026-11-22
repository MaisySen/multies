/**
 * Tools P2, H7: the editors' entries in a mail attachment's Tools menu (PDFs only, each behind its flag).
 * Rendered inside the menu, so GET /api/tools is read only when the menu opens.
 */
import { useNavigate } from "react-router";
import { MenuItem } from "@/web/components/ui/menu";
import { TOOLS_EDITORS } from "@/shared/tools-editors";
import { useToolFeatures } from "./runner";

const MENU_LABEL: Record<string, string> = { organize: "Edit pages", "form-fill": "Fill form", compare: "Compare with another version" };

export function EditorAttachmentItems({ id, filename }: { id: string; filename: string }) {
  const navigate = useNavigate();
  const f = useToolFeatures();
  if (!/\.pdf$/i.test(filename)) return null;
  return (
    <>
      {TOOLS_EDITORS.filter((t) => f.on(t.feature)).map((t) => (
        <MenuItem key={t.op} onSelect={() => navigate(`${t.path}?attachment=${encodeURIComponent(id)}&name=${encodeURIComponent(filename)}`)}>{MENU_LABEL[t.op] ?? t.label}</MenuItem>
      ))}
    </>
  );
}
