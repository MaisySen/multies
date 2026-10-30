/**
 * Tools P2, H7: one route for the three editors (/app/tools/pages, /app/tools/forms, /app/tools/compare).
 * A single parameter route keeps them out of the command menu until they ship (the lead adds menu
 * entries with the release).
 */
import { Navigate, useParams } from "react-router";
import { PageEditorPage } from "./page-editor";
import { FormFillerPage } from "./form-filler";
import { ComparePage } from "./compare";

export function ToolsEditorRoute() {
  const { editor } = useParams();
  if (editor === "pages") return <PageEditorPage />;
  if (editor === "forms") return <FormFillerPage />;
  if (editor === "compare") return <ComparePage />;
  return <Navigate to="/app/tools" replace />;
}
