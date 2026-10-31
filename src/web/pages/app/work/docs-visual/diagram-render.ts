/**
 * R89: draws a diagram from its text. Loaded only when a diagram is on screen (its own chunk). Strict security:
 * no clicks or scripts in diagrams, labels drawn as SVG text (no HTML), and the result sanitised before it is
 * shown. Colours come from our tokens, so light, dark and brand themes match the rest of the app.
 */
import mermaid from "mermaid";
import DOMPurify from "dompurify";
import { diagramThemeVariables, readDiagramError, MAX_DIAGRAM_SOURCE, type DiagramError, type ThemeTokens } from "@/web/lib/diagram";

let configured = "";
let seq = 0;
let queue: Promise<unknown> = Promise.resolve();

function configure(tokens: ThemeTokens) {
  const key = JSON.stringify(tokens);
  if (key === configured) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables: diagramThemeVariables(tokens),
    htmlLabels: false,
    flowchart: { htmlLabels: false, curve: "basis", padding: 12 },
    sequence: { useMaxWidth: true },
    gantt: { useMaxWidth: true },
    suppressErrorRendering: true,
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif",
  });
  configured = key;
}

export type RenderResult = { svg: string; error?: undefined } | { svg?: undefined; error: DiagramError };

/** One render at a time (the library keeps global state while it draws). */
export function renderDiagram(source: string, tokens: ThemeTokens): Promise<RenderResult> {
  const run = queue.then(() => draw(source, tokens));
  queue = run.catch(() => undefined);
  return run;
}

async function draw(source: string, tokens: ThemeTokens): Promise<RenderResult> {
  if (!source.trim()) return { error: readDiagramError(null, source) };
  if (source.length > MAX_DIAGRAM_SOURCE) return { error: { line: null, message: "This diagram is too long to draw. Split it into two.", detail: "" } };
  configure(tokens);
  try {
    await mermaid.parse(source);
  } catch (e) {
    return { error: readDiagramError(e, source) };
  }
  const id = `mm-diagram-${++seq}`;
  try {
    const { svg } = await mermaid.render(id, source);
    const clean = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ["style"], FORBID_TAGS: ["foreignObject", "script", "a"], FORBID_ATTR: ["onclick", "onload", "href", "xlink:href"] });
    return { svg: clean };
  } catch (e) {
    return { error: readDiagramError(e, source) };
  } finally {
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}
