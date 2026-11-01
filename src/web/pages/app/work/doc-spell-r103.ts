/**
 * R103: spell check in the doc editor. SpellAttrs puts the person's choice (on or off, language) on the editor's
 * editable element, so the browser's own dictionary underlines and suggests; fixInEditor applies "Check spelling"
 * fixes as one transaction (it skips code and links; co-editing carries it like any edit).
 */
import { useEffect } from "react";
import type { Editor } from "@tiptap/react";
import { useSpellPref } from "@/web/lib/spell-r103";

export function SpellAttrs({ editor }: { editor: Editor | null }) {
  const [pref] = useSpellPref();
  useEffect(() => {
    if (!editor) return;
    let dom: HTMLElement;
    try { dom = editor.view.dom as HTMLElement; } catch { return; }
    dom.setAttribute("spellcheck", pref.on ? "true" : "false");
    dom.setAttribute("lang", pref.lang);
  }, [editor, pref.on, pref.lang]);
  return null;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function fixInEditor(editor: Editor, fixes: { word: string; suggestion: string }[]) {
  const { state } = editor;
  const ranges: { from: number; to: number; text: string }[] = [];
  state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    if (node.marks.some((m) => m.type.name === "code" || m.type.name === "link")) return;
    for (const f of fixes) {
      const re = new RegExp(`(^|[^A-Za-z'])(${esc(f.word)})(?![A-Za-z'])`, "g");
      for (let m = re.exec(node.text); m; m = re.exec(node.text)) {
        const from = pos + m.index + m[1].length;
        ranges.push({ from, to: from + f.word.length, text: f.suggestion });
      }
    }
  });
  if (!ranges.length) return;
  const tr = state.tr;
  for (const r of ranges.sort((a, b) => b.from - a.from)) tr.insertText(r.text, r.from, r.to);
  editor.view.dispatch(tr);
}
