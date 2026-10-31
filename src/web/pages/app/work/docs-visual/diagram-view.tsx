/**
 * R89: the diagram block in a doc. Source on the left with line numbers, the drawing on the right (stacked on a
 * phone, drawing first), redrawn as you type. A line that does not read marks itself and says why under the
 * source; the last good drawing stays until it reads again. Readers see the drawing only.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { toast } from "sonner";
import { IconChevronDown, IconDownload, IconWarning, IconWorkflow } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";
import { showError } from "@/web/lib/show-error";
import { useDialogs } from "@/web/components/ui/confirm";
import { DIAGRAM_TEMPLATES, diagramKind, type DiagramError } from "@/web/lib/diagram";
import { readTokens, useThemeKey } from "./theme";
import { downloadBlob, safeName, svgBlob, svgToPng } from "./export-file";

type View = "split" | "code" | "preview";

export function DiagramView({ node, editor, getPos }: NodeViewProps) {
  const source = node.textContent;
  const editable = editor.isEditable;
  const themeKey = useThemeKey();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<DiagramError | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<View>("split");
  const [menu, setMenu] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const { confirm, dialogs } = useDialogs();
  const lines = useMemo(() => Math.max(1, source.split("\n").length), [source]);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      import("./diagram-render")
        .then((m) => m.renderDiagram(source, readTokens()))
        .then((r) => {
          if (!live) return;
          setFailed(false);
          if (r.svg !== undefined) { setSvg(r.svg); setError(null); } else setError(r.error);
          setLoading(false);
        })
        .catch(() => { if (live) { setFailed(true); setLoading(false); } });
    }, svg === null ? 0 : 250);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, themeKey, attempt]);

  const setSource = useCallback((code: string) => {
    const pos = typeof getPos === "function" ? getPos() : null;
    if (pos == null) return;
    editor.chain().command(({ tr, state }) => {
      tr.replaceWith(pos + 1, pos + 1 + node.content.size, code ? state.schema.text(code) : []);
      return true;
    }).run();
  }, [editor, getPos, node.content.size]);

  const exportAs = async (kind: "png" | "svg") => {
    if (!svg) return;
    try {
      const title = diagramKind(source);
      if (kind === "svg") downloadBlob(svgBlob(svg), safeName(title, "svg"));
      else downloadBlob(await svgToPng(svg, { scale: 2, background: readTokens().surface }), safeName(title, "png"));
      toast.success(kind === "svg" ? "Saved as SVG" : "Saved as PNG");
    } catch (e) { showError(e as Error); }
  };

  const showCode = editable && view !== "preview";
  const showPreview = !editable || view !== "code";
  return (
    <NodeViewWrapper as="div" className="mm-diagram not-prose my-3 overflow-hidden rounded-xl border border-line bg-surface" data-testid="diagram-block" data-view={editable ? view : "preview"}>
      {dialogs}
      <div contentEditable={false} className="flex flex-wrap items-center gap-1 border-b border-line px-2 py-1.5 text-[12.5px] text-muted">
        <span className="inline-flex items-center gap-1.5 px-1 font-medium text-fg"><IconWorkflow className="h-4 w-4 text-muted" aria-hidden />{diagramKind(source)}</span>
        {error && <span className="inline-flex items-center gap-1 rounded-full bg-warn-soft px-2 py-0.5 text-[11.5px] font-medium text-warn" data-testid="diagram-error-chip"><IconWarning className="h-3 w-3" aria-hidden />{error.line ? `Line ${error.line}` : "Check the text"}</span>}
        <span className="ml-auto" />
        {editable && (
          <div className="relative">
            <button type="button" className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-hover hover:text-fg max-sm:min-h-11" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
              Template<IconChevronDown className="h-3.5 w-3.5" aria-hidden />
            </button>
            {menu && (
              <div role="menu" className="absolute right-0 z-20 mt-1 w-56 rounded-lg border border-line bg-elevated p-1 shadow-pop" onKeyDown={(e) => { if (e.key === "Escape") setMenu(false); }}>
                {DIAGRAM_TEMPLATES.map((t) => (
                  <button key={t.id} type="button" role="menuitem" className="block w-full rounded-md px-2.5 py-1.5 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
                    onClick={async () => {
                      setMenu(false);
                      if (source.trim() && !(await confirm({ title: `Replace this diagram with the ${t.label.toLowerCase()} template?`, description: "Its text is replaced. Undo brings it back.", confirmLabel: "Replace" }))) return;
                      setSource(t.code);
                    }}>
                    <span className="block text-[13px] text-fg">{t.label}</span><span className="block text-[12px] text-subtle">{t.hint}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {editable && (
          <div role="group" aria-label="Show" className="inline-flex rounded-md border border-line p-0.5 max-sm:hidden">
            {(["code", "split", "preview"] as View[]).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)} className={cn("rounded px-2 py-0.5 text-[12px] transition-colors duration-150", view === v ? "bg-brand-soft text-brand-hover" : "hover:text-fg")}>
                {v === "code" ? "Text" : v === "split" ? "Both" : "Drawing"}
              </button>
            ))}
          </div>
        )}
        <button type="button" className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-hover hover:text-fg disabled:opacity-50 max-sm:min-h-11" disabled={!svg} onClick={() => void exportAs("png")} aria-label="Download as PNG"><IconDownload className="h-3.5 w-3.5" aria-hidden />PNG</button>
        <button type="button" className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-hover hover:text-fg disabled:opacity-50 max-sm:min-h-11" disabled={!svg} onClick={() => void exportAs("svg")} aria-label="Download as SVG"><IconDownload className="h-3.5 w-3.5" aria-hidden />SVG</button>
      </div>
      <div className={cn("grid", showCode && showPreview && "md:grid-cols-2")}>
        {showCode && (
          <div className={cn("min-w-0 border-line bg-bg/60", showPreview && "max-md:order-2 max-md:border-t md:border-r")}>
            <div className="mm-diagram-src flex max-h-[420px] overflow-auto font-mono text-[12.5px] leading-[20px]">
              <div contentEditable={false} aria-hidden className="select-none py-2 pl-2 pr-2 text-right text-subtle">
                {Array.from({ length: lines }, (_, i) => (
                  <div key={i} className={cn("px-1", error?.line === i + 1 && "rounded bg-bad-soft font-semibold text-bad")} data-error-line={error?.line === i + 1 ? "true" : undefined}>{i + 1}</div>
                ))}
              </div>
              <NodeViewContent as="div" className="mm-diagram-code min-w-0 flex-1 whitespace-pre py-2 pr-3 text-fg outline-none" spellCheck={false} aria-label="Diagram text" data-testid="diagram-source" />
            </div>
            {error && (
              <div contentEditable={false} role="alert" className="flex items-start gap-2 border-t border-line bg-warn-soft/60 px-3 py-2 text-[12.5px] text-fg" data-testid="diagram-error">
                <IconWarning className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" aria-hidden />
                <span><span className="font-medium">{error.message}</span>{error.detail && <span className="mt-0.5 block font-mono text-[11.5px] text-muted">{error.detail}</span>}</span>
              </div>
            )}
          </div>
        )}
        {showPreview && (
          <div contentEditable={false} className={cn("relative flex min-h-[180px] items-center justify-center overflow-auto p-4", showCode && "max-md:order-1")} data-testid="diagram-preview">
            {loading && !svg ? <div className="h-36 w-full animate-pulse rounded-lg bg-fill" aria-label="Drawing the diagram" />
              : failed && !svg ? (
                <p className="text-center text-[13px] text-muted">Could not load the drawing. <button type="button" className="font-medium text-brand-hover underline" onClick={() => { setLoading(true); setAttempt((n) => n + 1); }}>Try again</button></p>
              ) : svg ? <div className={cn("mm-diagram-svg w-full [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full", error && "opacity-60")} role="img" aria-label={`${diagramKind(source)} drawing`} dangerouslySetInnerHTML={{ __html: svg }} />
                : <p className="text-center text-[13px] text-muted">{error?.message ?? "Nothing to draw yet."}</p>}
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
}
