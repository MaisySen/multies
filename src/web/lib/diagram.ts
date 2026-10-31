/**
 * R89: diagram blocks drawn from text. The pure half: starter templates, reading a parse error into a line and a
 * plain message, and the colours handed to the renderer from our own theme tokens. The renderer itself
 * (diagram-render.ts) loads only when a diagram is on screen.
 */
export type DiagramTemplate = "flowchart" | "sequence" | "org" | "er" | "gantt";

export const DIAGRAM_TEMPLATES: { id: DiagramTemplate; label: string; hint: string; code: string }[] = [
  {
    id: "flowchart", label: "Flowchart", hint: "Steps and decisions",
    code: "flowchart LR\n  A[Request comes in] --> B{Approved?}\n  B -->|Yes| C[Send to client]\n  B -->|No| D[Ask for changes]\n  D --> A",
  },
  {
    id: "sequence", label: "Sequence", hint: "Who talks to whom, in order",
    code: "sequenceDiagram\n  participant C as Client\n  participant T as Team\n  C->>T: Sends the brief\n  T->>C: Shares a first draft\n  C->>T: Approves it",
  },
  {
    id: "org", label: "Org chart", hint: "People and who they report to",
    code: "flowchart TD\n  CEO[Alex, CEO]\n  CEO --> OPS[Sam, Operations]\n  CEO --> FIN[Priya, Finance]\n  OPS --> S1[Jo, Support]\n  OPS --> S2[Lee, Delivery]",
  },
  {
    id: "er", label: "Data model", hint: "Tables and how they link",
    code: "erDiagram\n  CLIENT ||--o{ PROJECT : has\n  PROJECT ||--|{ TASK : contains\n  CLIENT {\n    string name\n    string email\n  }\n  PROJECT {\n    string title\n    date due\n  }",
  },
  {
    id: "gantt", label: "Timeline", hint: "Phases on a calendar",
    code: "gantt\n  title Launch plan\n  dateFormat YYYY-MM-DD\n  section Plan\n  Brief and scope :a1, 2026-11-02, 5d\n  section Build\n  First version :a2, after a1, 10d\n  Review :a3, after a2, 3d",
  },
];

export const templateCode = (id: DiagramTemplate | string) => (DIAGRAM_TEMPLATES.find((t) => t.id === id) ?? DIAGRAM_TEMPLATES[0]).code;

export const MAX_DIAGRAM_SOURCE = 20_000;

export interface DiagramError { line: number | null; message: string; detail: string }

interface ErrLike { message?: unknown; str?: unknown; hash?: { line?: unknown; loc?: { first_line?: unknown } } }

/**
 * Reads what the renderer threw into the line that failed (1 based, counted in the source as typed) and a short
 * plain message. Never throws.
 */
export function readDiagramError(err: unknown, source: string): DiagramError {
  const e = (err && typeof err === "object" ? err : { message: String(err ?? "") }) as ErrLike;
  const raw = String(e.message ?? e.str ?? "").trim();
  const lines = source.split("\n");
  let line: number | null = null;
  const loc = Number(e.hash?.loc?.first_line);
  if (Number.isFinite(loc) && loc > 0) line = loc;
  else if (Number.isFinite(Number(e.hash?.line))) line = Number(e.hash?.line) + 1;
  else {
    const m = /line[\s:]+(\d+)/i.exec(raw);
    if (m) line = Number(m[1]);
  }
  if (line !== null && (line < 1 || line > lines.length)) line = Math.min(Math.max(1, line), lines.length);
  const first = (lines.find((l) => l.trim()) ?? "").trim();
  let message: string;
  if (!source.trim()) message = "Type a diagram, or pick a template.";
  else if (/no diagram type detected|unknown diagram|diagram type/i.test(raw)) message = `The first line should name the diagram type, like flowchart, sequenceDiagram, erDiagram or gantt. It says "${first.slice(0, 40)}".`;
  else if (line !== null) message = `Line ${line} does not read right. Check its brackets, quotes and arrows.`;
  else message = "This diagram does not read right yet. Check the last line you changed.";
  const detail = raw.split("\n").filter((l) => l.trim() && !/^-+\^?$/.test(l.trim())).slice(0, 3).join(" ").slice(0, 240);
  return { line, message, detail };
}

/** First word of the source: the diagram type, for the block's label. */
export function diagramKind(source: string): string {
  const w = (source.split("\n").find((l) => l.trim() && !l.trim().startsWith("%%")) ?? "").trim().split(/\s+/)[0] ?? "";
  const names: Record<string, string> = { flowchart: "Flowchart", graph: "Flowchart", sequenceDiagram: "Sequence", erDiagram: "Data model", gantt: "Timeline", classDiagram: "Class diagram", stateDiagram: "State diagram", "stateDiagram-v2": "State diagram", pie: "Pie chart", mindmap: "Mind map", journey: "Journey", timeline: "Timeline" };
  return names[w] ?? "Diagram";
}

export interface ThemeTokens { bg: string; surface: string; fg: string; muted: string; line: string; brand: string; brandSoft: string; dark: boolean }

/** The renderer's theme variables from our tokens, so a diagram matches light, dark and brand themes like Forest. */
export function diagramThemeVariables(t: ThemeTokens): Record<string, string | boolean> {
  return {
    darkMode: t.dark,
    background: t.surface,
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif",
    fontSize: "14px",
    primaryColor: t.brandSoft,
    primaryTextColor: t.fg,
    primaryBorderColor: t.brand,
    secondaryColor: t.surface,
    secondaryTextColor: t.fg,
    secondaryBorderColor: t.line,
    tertiaryColor: t.bg,
    tertiaryTextColor: t.fg,
    tertiaryBorderColor: t.line,
    lineColor: t.muted,
    textColor: t.fg,
    mainBkg: t.brandSoft,
    nodeBorder: t.brand,
    clusterBkg: t.bg,
    clusterBorder: t.line,
    titleColor: t.fg,
    edgeLabelBackground: t.surface,
    actorBkg: t.brandSoft,
    actorBorder: t.brand,
    actorTextColor: t.fg,
    actorLineColor: t.muted,
    signalColor: t.fg,
    signalTextColor: t.fg,
    labelBoxBkgColor: t.surface,
    labelBoxBorderColor: t.line,
    labelTextColor: t.fg,
    loopTextColor: t.fg,
    noteBkgColor: t.surface,
    noteBorderColor: t.line,
    noteTextColor: t.fg,
    sectionBkgColor: t.brandSoft,
    altSectionBkgColor: t.bg,
    sectionBkgColor2: t.surface,
    taskBkgColor: t.brand,
    taskBorderColor: t.brand,
    taskTextColor: "#ffffff",
    taskTextOutsideColor: t.fg,
    taskTextLightColor: t.fg,
    activeTaskBkgColor: t.brandSoft,
    activeTaskBorderColor: t.brand,
    gridColor: t.line,
    doneTaskBkgColor: t.muted,
    doneTaskBorderColor: t.muted,
    todayLineColor: t.brand,
    attributeBackgroundColorOdd: t.surface,
    attributeBackgroundColorEven: t.bg,
  };
}
