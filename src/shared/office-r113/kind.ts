/** R113: which browser editor a Files item opens in (kept tiny so the Files page does not load the editors). */
export type OfficeKind = "docx" | "xlsx" | "csv" | "pptx";
export function officeKindOf(name: string): OfficeKind | null {
  const m = /\.(docx|xlsx|csv|pptx)$/i.exec(name);
  return m ? (m[1].toLowerCase() as OfficeKind) : null;
}
export const officeActionLabel = (k: OfficeKind) => (k === "pptx" ? "View slides" : "Open in editor");
export const officeEditPath = (id: string) => `/app/files/edit/${encodeURIComponent(id)}`;
