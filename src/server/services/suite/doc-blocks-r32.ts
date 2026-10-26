/**
 * R32: one block (table, image or callout) as the markdown the docs service already reads
 * (markdown-doc.ts), so the MCP tool and the editor write the same shape.
 */
import { HttpError } from "../../lib/errors";

export type DocBlockInput =
  | { type: "table"; rows: string[][]; header?: boolean }
  | { type: "image"; url: string; alt?: string }
  | { type: "callout"; variant?: "info" | "success" | "warning" | "danger"; text: string };

const cell = (s: string) => s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();

export function blockMarkdown(b: DocBlockInput): string {
  if (b.type === "table") {
    const rows = b.rows.filter((r) => Array.isArray(r));
    if (!rows.length) throw new HttpError(422, "validation_failed", "A table needs at least one row.");
    const cols = Math.max(...rows.map((r) => r.length), 1);
    const pad = (r: string[]) => `| ${Array.from({ length: cols }, (_, i) => cell(r[i] ?? "") || " ").join(" | ")} |`;
    const head = b.header === false ? Array.from({ length: cols }, () => "") : rows[0];
    const body = b.header === false ? rows : rows.slice(1);
    return [pad(head), `|${" --- |".repeat(cols)}`, ...body.map(pad)].join("\n");
  }
  if (b.type === "image") {
    let u: URL;
    try { u = new URL(b.url); } catch { throw new HttpError(422, "validation_failed", "url must be an https link to an image."); }
    if (u.protocol !== "https:") throw new HttpError(422, "validation_failed", "url must be an https link to an image.");
    return `![${(b.alt ?? "").replace(/[[\]\n]/g, " ").trim()}](${u.toString().replace(/\)/g, "%29").replace(/\s/g, "%20")})`;
  }
  return `:::${b.variant ?? "info"}\n${b.text.replace(/^:::\s*$/gm, "")}\n:::`;
}
