/**
 * Tools (document tools inside Multies). The catalogue the web app and the server share.
 * The work runs on the private document engine; people only ever talk to Multies.
 */
export type ToolOp = "compress" | "merge" | "convert";

export interface ToolDef {
  op: ToolOp;
  label: string;
  /** One plain line under the title. */
  blurb: string;
  /** What the drop zone takes (an accept attribute) and the words for it. */
  accept: string;
  acceptLabel: string;
  minFiles: number;
  /** The most files a run takes; merge is capped by the plan instead. */
  maxFiles: number | "plan";
  /** Added to the first file's name for the result, e.g. "invoice-compressed.pdf". */
  suffix: string;
}

export const TOOLS: ToolDef[] = [
  { op: "compress", label: "Compress PDF", blurb: "Make a PDF smaller so it is easier to send.", accept: ".pdf,application/pdf", acceptLabel: "a PDF", minFiles: 1, maxFiles: 1, suffix: "-compressed" },
  { op: "merge", label: "Merge PDFs", blurb: "Join several PDFs into one, in the order you choose.", accept: ".pdf,application/pdf", acceptLabel: "2 or more PDFs", minFiles: 2, maxFiles: "plan", suffix: "-merged" },
  { op: "convert", label: "Convert to PDF", blurb: "Turn a Word, Excel, PowerPoint or OpenDocument file into a PDF.", accept: ".docx,.xlsx,.pptx,.odt,.ods,.odp", acceptLabel: "a Word, Excel, PowerPoint or OpenDocument file", minFiles: 1, maxFiles: 1, suffix: "" },
];

export const TOOL_OPS = TOOLS.map((t) => t.op);
export const isToolOp = (v: unknown): v is ToolOp => typeof v === "string" && (TOOL_OPS as string[]).includes(v);
export const toolDef = (op: ToolOp) => TOOLS.find((t) => t.op === op)!;

/** The result's file name from the first input's name: letters, numbers and simple marks only. */
export function resultName(op: ToolOp, firstName: string | null | undefined): string {
  const base = (firstName ?? "").replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[^A-Za-z0-9 _.()+-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "document";
  return `${base}${toolDef(op).suffix}.pdf`;
}

export interface ToolsUsage { month: number; day: number }
export interface ToolsLimits { runsMonthly: number; runsDaily: number; maxBytes: number; maxMergeFiles: number }
export interface ToolsInfo { enabled: boolean; tools: ToolDef[]; usage: ToolsUsage; limits: ToolsLimits }
export type ToolJobStatus = "queued" | "running" | "done" | "failed" | "expired";
export interface ToolJob { token: string; op: ToolOp; status: ToolJobStatus; name: string; error?: string; bytes?: number; downloadUrl?: string }
