/**
 * Tools P2, H7: one route for the three editors (/app/tools/pages, /app/tools/forms, /app/tools/compare).
 * A single parameter route keeps them out of the command menu until they ship (the lead adds menu
 * entries with the release). R66 (MB-259): an editor whose feature is off is a plain not found page.
 */
import { Navigate, useParams } from "react-router";
import { ToolFeatureGate } from "@/web/components/tools/feature-gate";
import { PageEditorPage } from "./page-editor";
import { FormFillerPage } from "./form-filler";
import { ComparePage } from "./compare";

export function ToolsEditorRoute() {
  const { editor } = useParams();
  if (editor === "pages") return <ToolFeatureGate features={["editor"]}><PageEditorPage /></ToolFeatureGate>;
  if (editor === "forms") return <ToolFeatureGate features={["forms"]}><FormFillerPage /></ToolFeatureGate>;
  if (editor === "compare") return <ToolFeatureGate features={["compare"]}><ComparePage /></ToolFeatureGate>;
  return <Navigate to="/app/tools" replace />;
}
