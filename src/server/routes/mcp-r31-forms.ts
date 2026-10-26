/**
 * R31: form logic and results over MCP. form_logic_set sets one question's "show if" logic, answer
 * rules and required switch; form_results returns the per-question summary and the newest
 * responses. Same services as PUT /api/v1/forms/{id}/fields/{fieldId}/logic and GET
 * /api/v1/forms/{id}/summary and /responses (services/suite/form-results.ts).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { formResponses, formSummary, setFieldLogic, type LogicInput } from "../services/suite/form-results";
import type { Scoped } from "./mcp-server";
import { FieldLogicSchema, FieldRulesSchema } from "./forms-r31";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerFormsR31Tools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  server.registerTool("form_logic_set", {
    title: "Set a form question's logic and rules", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Shows a question only when conditions on EARLIER questions hold, and sets its answer rules. logic: { join: \"all\" | \"any\", conditions: [{ field: <question id>, op: is | is_not | contains | answered | not_answered | gt | lt, value }] }, null clears it. rules: minLength, maxLength (text), min, max (number), minSelected, maxSelected (multiselect), pattern and patternMessage (text, phone); null clears them. A hidden question is never required. Loops, a question depending on itself or on a later question answer validation_failed. Question ids come from list_forms.",
    inputSchema: { formId: z.string().min(1), fieldId: z.string().min(1).max(40), logic: FieldLogicSchema.optional(), rules: FieldRulesSchema.optional(), required: z.boolean().optional() },
  }, tool(async (x: { formId: string; fieldId: string } & LogicInput) => {
    writable();
    const { field, form } = await setFieldLogic(deps, a, x.formId, x.fieldId, { logic: x.logic, rules: x.rules, required: x.required });
    return { formId: form.id, version: form.version, field };
  }) as never);

  server.registerTool("form_results", {
    title: "Form results", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "A form's results: total responses, a summary per question (counts per option for choices, average/min/max for numbers, latest answers for text) and the newest responses with their answers keyed by question id. from and to (YYYY-MM-DD) filter by day, q searches answers, limit is how many responses to return (up to 50).",
    inputSchema: { formId: z.string().min(1), from: z.string().max(30).optional(), to: z.string().max(30).optional(), q: z.string().max(100).optional(), limit: z.number().int().min(0).max(50).optional() },
  }, tool(async (x: { formId: string; from?: string; to?: string; q?: string; limit?: number }) => {
    const filter = { from: x.from, to: x.to, q: x.q };
    const summary = await formSummary(deps, a.orgId, x.formId, filter);
    const limit = x.limit ?? 10;
    const recent = limit ? await formResponses(deps, a.orgId, x.formId, { ...filter, limit }) : { responses: [] };
    return { ...summary, responses: recent.responses };
  }) as never);
}
