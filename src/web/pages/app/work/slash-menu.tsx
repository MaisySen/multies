/**
 * R31: the "/" menu in docs. Type "/" at the start of a line or after a space, then filter by
 * typing; Up and Down move, Enter or Tab picks, Escape closes. Only this client's own typing
 * opens it, and picking runs one local editor command, so a second person in the doc sees the
 * result once (through the shared document) and never a menu or duplicate content.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { IconCalendar, IconCheckCircle, IconCode, IconHeading1, IconHeading2, IconHeading3, IconImage, IconInfo, IconLink, IconList, IconListOrdered, IconMinus, IconOctagonAlert, IconQuote, IconShapes, IconTable, IconTasks, IconText, IconWarning, IconWorkflow, type IconComponent } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";
import { filterSlash, groupSlash, moveSel, slashQuery, todayText, type SlashItem } from "@/web/lib/slash-commands";
import { templateCode } from "@/web/lib/diagram"; // R89
import { tr } from "@/web/i18n"; // R104B
import "@/web/i18n/w2/en-docs"; // R104B

const ICONS: Record<string, IconComponent> = { text: IconText, h1: IconHeading1, h2: IconHeading2, h3: IconHeading3, quote: IconQuote, code: IconCode, divider: IconMinus, bullets: IconList, numbers: IconListOrdered, todo: IconTasks, link: IconLink, date: IconCalendar,
  table: IconTable, image: IconImage, callout: IconInfo, "callout-success": IconCheckCircle, "callout-warning": IconWarning, "callout-danger": IconOctagonAlert,
  whiteboard: IconShapes, diagram: IconWorkflow, "diagram-sequence": IconWorkflow, "diagram-org": IconWorkflow, "diagram-er": IconWorkflow, "diagram-gantt": IconWorkflow }; // R89

interface MenuState { from: number; to: number; query: string; left: number; top: number }

/** Runs a picked item: removes the "/query" text, then applies the block. */
export function runSlashItem(editor: Editor, item: SlashItem, range: { from: number; to: number }, openLinkPicker?: () => void, openImage?: () => void) {
  const chain = editor.chain().focus().deleteRange(range);
  const a = item.action;
  switch (a.kind) {
    case "paragraph": chain.setParagraph().run(); break;
    case "heading": chain.setHeading({ level: a.level }).run(); break;
    case "bulletList": chain.toggleBulletList().run(); break;
    case "orderedList": chain.toggleOrderedList().run(); break;
    case "taskList": chain.toggleTaskList().run(); break;
    case "blockquote": chain.toggleBlockquote().run(); break;
    case "codeBlock": chain.toggleCodeBlock().run(); break;
    case "horizontalRule": chain.setHorizontalRule().run(); break;
    case "date": chain.insertContent(`${todayText()} `).run(); break;
    case "linkPicker": chain.run(); openLinkPicker?.(); break;
    // R32
    case "table": chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); break;
    case "image": chain.run(); openImage?.(); break;
    case "callout": chain.setCallout(a.variant).run(); break;
    case "whiteboard": chain.insertWhiteboard().run(); break; // R89
    case "diagram": chain.insertDiagram(templateCode(a.template)).run(); break; // R89
  }
}

export function SlashMenu({ editor, onLinkPicker, onImage }: { editor: Editor | null; onLinkPicker?: () => void; onImage?: () => void }) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [sel, setSel] = useState(0);
  const dismissedAt = useRef<number | null>(null);
  const menuRef = useRef<MenuState | null>(null);
  menuRef.current = menu;
  const items = menu ? filterSlash(menu.query) : [];
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const selRef = useRef(sel);
  selRef.current = sel;

  const close = useCallback(() => { setMenu(null); setSel(0); }, []);
  const pick = useCallback((item: SlashItem | undefined) => {
    const m = menuRef.current;
    if (!editor || !m || !item) return;
    close();
    runSlashItem(editor, item, { from: m.from, to: m.to }, onLinkPicker, onImage);
  }, [editor, close, onLinkPicker, onImage]);

  useEffect(() => {
    if (!editor) return;
    const read = ({ transaction }: { transaction: { docChanged: boolean; getMeta: (k: string) => unknown } }) => {
      const remote = !!transaction.getMeta("y-sync$");
      const { selection } = editor.state;
      const $from = selection.$from;
      if (!selection.empty || !$from.parent.isTextblock || $from.parent.type.name === "codeBlock") { if (menuRef.current) close(); return; }
      const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
      const query = slashQuery(before);
      if (query === null) { if (menuRef.current) close(); dismissedAt.current = null; return; }
      const start = selection.from - query.length - 1;
      // Open only on this person's own typing; once open, follow the caret (remote edits included).
      if (!menuRef.current && (remote || !transaction.docChanged)) return;
      if (dismissedAt.current === start) return;
      const at = editor.view.coordsAtPos(start);
      if (!menuRef.current || menuRef.current.query !== query) setSel(0);
      setMenu({ from: start, to: selection.from, query, left: at.left, top: at.bottom + 6 });
    };
    editor.on("transaction", read as never);
    return () => { editor.off("transaction", read as never); };
  }, [editor, close]);

  // Keys go to the menu before the editor sees them (capture phase on the editor's own element).
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom as HTMLElement;
    const onKey = (e: KeyboardEvent) => {
      if (!menuRef.current || e.isComposing) return;
      const n = itemsRef.current.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); setSel((s) => moveSel(s, e.key === "ArrowDown" ? 1 : -1, n)); }
      else if ((e.key === "Enter" || e.key === "Tab") && n) { e.preventDefault(); e.stopPropagation(); pick(itemsRef.current[selRef.current]); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); dismissedAt.current = menuRef.current.from; close(); }
    };
    dom.addEventListener("keydown", onKey, true);
    const onBlur = () => setTimeout(() => { if (!dom.contains(document.activeElement)) close(); }, 120);
    dom.addEventListener("blur", onBlur);
    return () => { dom.removeEventListener("keydown", onKey, true); dom.removeEventListener("blur", onBlur); };
  }, [editor, pick, close]);

  useEffect(() => {
    if (!menu) return;
    document.getElementById(`slash-item-${sel}`)?.scrollIntoView({ block: "nearest" });
  }, [sel, menu]);

  if (!menu || !editor) return null;
  const groups = groupSlash(items, !!menu.query);
  const left = Math.max(8, Math.min(menu.left, window.innerWidth - 296));
  const top = menu.top + 320 > window.innerHeight ? Math.max(8, menu.top - 330) : menu.top;
  return (
    <div role="listbox" aria-label={tr("docs.insert_a_block")} id="slash-menu" data-testid="slash-menu"
      className="fixed z-40 w-72 animate-pop-in overflow-hidden rounded-xl border border-line bg-elevated shadow-pop motion-reduce:animate-none"
      style={{ left, top }} onMouseDown={(e) => e.preventDefault()}>
      <div className="max-h-80 overflow-y-auto p-1.5">
        {!groups.length && <p className="px-2 py-2 text-[13px] text-subtle">{tr("docs.no_blocks_match_query", { query: menu.query })}</p>}
        {groups.map((g) => (
          <div key={g.group} role="group" aria-label={g.group}>
            <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-subtle">{g.group}</div>
            {g.items.map(({ item, index }) => {
              const Icon = ICONS[item.id] ?? IconText;
              return (
                <button key={item.id} id={`slash-item-${index}`} type="button" role="option" aria-selected={index === sel} data-testid={`slash-${item.id}`}
                  onClick={() => pick(item)} onMouseEnter={() => setSel(index)}
                  className={cn("flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-150", index === sel ? "bg-brand/10 text-fg" : "text-muted hover:text-fg")}>
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line bg-surface"><Icon className="h-3.5 w-3.5" aria-hidden /></span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-[13.5px] text-fg">{item.label}</span><span className="block truncate text-[11.5px] text-subtle">{item.hint}</span></span>
                  {item.markdown && <kbd className="shrink-0 rounded border border-line px-1 font-mono text-[10.5px] text-subtle">{item.markdown}</kbd>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
