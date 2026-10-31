/**
 * R89: our own renderer for doc blocks (Tiptap JSON to React), used by Present. Text and attributes go through
 * React, so nothing in a doc can inject markup. Diagrams draw through the same strict renderer as the editor;
 * whiteboards show their saved drawing.
 */
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { lazyPage } from "@/web/components/lazy-page";
import { calloutVariant } from "@/web/lib/docs-callout";
import { isSafeImageSrc } from "@/web/lib/docs-blocks-schema";
import type { PMNode } from "@/web/lib/mindmap-tree";
import { readTokens, useThemeKey } from "./theme";

const BoardPicture = lazyPage(() => import("./board-picture"), "default", { quiet: true });

type Mark = { type: string; attrs?: Record<string, unknown> };

function inline(nodes: PMNode[] | undefined, key = "i"): ReactNode[] {
  return (nodes ?? []).map((n, i) => {
    const k = `${key}.${i}`;
    if (n.type === "hardBreak") return <br key={k} />;
    if (n.type === "mention") return <span key={k} className="font-medium text-brand-hover">@{String(n.attrs?.label ?? n.attrs?.name ?? "")}</span>;
    if (n.type !== "text") return <span key={k}>{inline(n.content, k)}</span>;
    let el: ReactNode = n.text ?? "";
    for (const m of (n.marks ?? []) as Mark[]) {
      if (m.type === "bold") el = <strong>{el}</strong>;
      else if (m.type === "italic") el = <em>{el}</em>;
      else if (m.type === "strike") el = <s>{el}</s>;
      else if (m.type === "underline") el = <u>{el}</u>;
      else if (m.type === "code") el = <code className="rounded bg-fill px-1 font-mono text-[0.9em]">{el}</code>;
      else if (m.type === "link") {
        const href = String(m.attrs?.href ?? "");
        el = /^(https?:|mailto:|\/)/i.test(href) ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-brand-hover underline">{el}</a> : el;
      }
    }
    return <span key={k}>{el}</span>;
  });
}

export function Blocks({ blocks, keyPrefix = "b" }: { blocks: PMNode[]; keyPrefix?: string }) {
  return <>{blocks.map((b, i) => <Block key={`${keyPrefix}.${i}`} n={b} k={`${keyPrefix}.${i}`} />)}</>;
}

function Block({ n, k }: { n: PMNode; k: string }): ReactNode {
  const kids = () => <Blocks blocks={n.content ?? []} keyPrefix={k} />;
  switch (n.type) {
    case "paragraph": return <p>{inline(n.content, k)}</p>;
    case "heading": {
      const l = Math.min(Math.max(Number(n.attrs?.level) || 3, 3), 4);
      return l === 3 ? <h3>{inline(n.content, k)}</h3> : <h4>{inline(n.content, k)}</h4>;
    }
    case "bulletList": return <ul className="list-disc pl-[1.2em]">{kids()}</ul>;
    case "orderedList": return <ol className="list-decimal pl-[1.4em]" start={Number(n.attrs?.start) || 1}>{kids()}</ol>;
    case "listItem": return <li>{kids()}</li>;
    case "taskList": return <ul className="list-none pl-0">{kids()}</ul>;
    case "taskItem": return (
      <li className="flex items-start gap-[0.5em]">
        <span aria-hidden className={`mt-[0.3em] inline-block h-[0.85em] w-[0.85em] shrink-0 rounded-[0.2em] border-2 ${n.attrs?.checked ? "border-brand bg-brand" : "border-muted"}`} />
        <span className="sr-only">{n.attrs?.checked ? "Done: " : "To do: "}</span>
        <div className={n.attrs?.checked ? "text-muted line-through" : ""}>{kids()}</div>
      </li>
    );
    case "blockquote": return <blockquote className="border-l-4 border-line pl-[0.8em] text-muted">{kids()}</blockquote>;
    case "codeBlock": return <pre className="overflow-auto rounded-xl bg-fill p-[0.8em] font-mono text-[0.75em]"><code>{(n.content ?? []).map((t) => t.text ?? "").join("")}</code></pre>;
    case "horizontalRule": return <hr className="border-line" />;
    case "callout": return <div className="mm-callout" data-callout={calloutVariant(n.attrs?.variant)} role="note">{kids()}</div>;
    case "image": {
      const src = String(n.attrs?.src ?? "");
      if (!isSafeImageSrc(src)) return null;
      return <img src={src} alt={String(n.attrs?.alt ?? "")} className="mx-auto max-h-[60vh] max-w-full rounded-xl object-contain" loading="lazy" />;
    }
    case "table": return (
      <div className="overflow-auto"><table className="w-full border-collapse text-[0.8em]"><tbody>
        {(n.content ?? []).map((row, r) => (
          <tr key={r}>{(row.content ?? []).map((cell, c) => cell.type === "tableHeader"
            ? <th key={c} className="border border-line bg-fill px-[0.5em] py-[0.25em] text-left"><Blocks blocks={cell.content ?? []} keyPrefix={`${k}.${r}.${c}`} /></th>
            : <td key={c} className="border border-line px-[0.5em] py-[0.25em] align-top"><Blocks blocks={cell.content ?? []} keyPrefix={`${k}.${r}.${c}`} /></td>)}</tr>
        ))}
      </tbody></table></div>
    );
    case "diagram": return <DiagramPicture source={(n.content ?? []).map((t) => t.text ?? "").join("")} />;
    case "whiteboard": return <Suspense fallback={<div className="h-48 animate-pulse rounded-xl bg-fill" />}><BoardPicture scene={String(n.attrs?.scene ?? "[]")} /></Suspense>;
    default: return n.content ? kids() : null;
  }
}

export function DiagramPicture({ source }: { source: string }) {
  const themeKey = useThemeKey();
  const [svg, setSvg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    import("./diagram-render").then((m) => m.renderDiagram(source, readTokens())).then((r) => {
      if (!live) return;
      if (r.svg !== undefined) { setSvg(r.svg); setErr(null); } else setErr(r.error.message);
    }).catch(() => { if (live) setErr("Could not draw this diagram."); });
    return () => { live = false; };
  }, [source, themeKey]);
  if (err && !svg) return <p className="text-[0.7em] text-muted">{err}</p>;
  if (!svg) return <div className="h-48 animate-pulse rounded-xl bg-fill" />;
  return <div role="img" aria-label="Diagram" className="mm-diagram-svg [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-h-[62vh] [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />;
}
