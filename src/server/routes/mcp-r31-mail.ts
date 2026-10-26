/**
 * R31: Inbox splits and read status over MCP. Splits are a person's own, so they need a personal key or an
 * OAuth sign in (agent keys get 403). list_threads takes split too (mcp-server.ts).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import { createSplit, deleteSplit, listSplits, splitTabs, updateSplit, type SplitActor } from "../services/mail/splits";
import { readStatusOf } from "../services/mail/read-status";
import { mailboxScope } from "../services/team";
import { SPLIT_FIELDS, SPLIT_NAME_MAX, SPLIT_RULES_MAX, SPLIT_VALUE_MAX } from "@/shared/mail-splits";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;
const Rule = z.object({ field: z.enum(SPLIT_FIELDS), value: z.string().max(SPLIT_VALUE_MAX).optional() });
const RULES_HELP = "Rules: fromContains, fromDomain (example.com), to (an address or a mailbox id), subjectContains, calendarInvite and fromTeammate (no value). match all (default) or any. leavesImportant (default true) takes matching mail out of Important and Other.";

export function registerMailR31Tools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SplitActor & { role?: "owner" | "admin" | "member" };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scope = () => (a.agentId ? Promise.resolve(null) : mailboxScope(deps.db, a as any));
  const norm = (rules: { field: (typeof SPLIT_FIELDS)[number]; value?: string }[]) => rules.map((r) => ({ field: r.field, value: r.value ?? "" }));

  server.registerTool("mail_split_list", {
    title: "List Inbox splits", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "Your Inbox tabs: Important (mail from people), Other (newsletters, notifications, receipts), then your own splits, each with its unread count, plus each split's rules. Pass a tab id as split to list_threads.",
    inputSchema: { mailboxId: z.string().max(64).optional() },
  }, tool(async (x: { mailboxId?: string }) => ({ splits: await listSplits(deps, a), tabs: await splitTabs(deps, a, { mailboxId: x.mailboxId, scope: await scope() }) })) as never);

  server.registerTool("mail_split_create", {
    title: "Create an Inbox split", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: `Adds a tab to your Inbox for mail that matches rules. ${RULES_HELP}`,
    inputSchema: {
      name: z.string().min(1).max(SPLIT_NAME_MAX),
      rules: z.array(Rule).min(1).max(SPLIT_RULES_MAX),
      match: z.enum(["all", "any"]).optional(),
      leavesImportant: z.boolean().optional(),
    },
  }, tool(async (x: { name: string; rules: { field: (typeof SPLIT_FIELDS)[number]; value?: string }[]; match?: "all" | "any"; leavesImportant?: boolean }) => {
    writable();
    return { split: await createSplit(deps, a, { ...x, rules: norm(x.rules) }) };
  }) as never);

  server.registerTool("mail_split_update", {
    title: "Edit an Inbox split", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: `Renames, reorders or changes the rules of one of your splits. ${RULES_HELP}`,
    inputSchema: {
      splitId: z.string().min(1).max(64),
      name: z.string().min(1).max(SPLIT_NAME_MAX).optional(),
      rules: z.array(Rule).min(1).max(SPLIT_RULES_MAX).optional(),
      match: z.enum(["all", "any"]).optional(),
      leavesImportant: z.boolean().optional(),
      position: z.number().int().min(0).max(100).optional(),
    },
  }, tool(async (x: { splitId: string; name?: string; rules?: { field: (typeof SPLIT_FIELDS)[number]; value?: string }[]; match?: "all" | "any"; leavesImportant?: boolean; position?: number }) => {
    writable();
    const { splitId, rules, ...rest } = x;
    return { split: await updateSplit(deps, a, splitId, { ...rest, ...(rules ? { rules: norm(rules) } : {}) }) };
  }) as never);

  server.registerTool("mail_split_delete", {
    title: "Delete an Inbox split", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: "Removes one of your splits. Its mail goes back to Important or Other; no mail is deleted.",
    inputSchema: { splitId: z.string().min(1).max(64) },
  }, tool(async (x: { splitId: string }) => {
    writable();
    return deleteSplit(deps, a, x.splitId);
  }) as never);

  server.registerTool("mail_read_status", {
    title: "Read status of a sent message", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "Whether a sent message was opened: { tracked, opens, firstOpenAt, lastOpenAt }. tracked is false when the sender had read status off (Settings > Mail). Image blocking means a message can be read without showing as opened.",
    inputSchema: { messageId: z.string().min(1).max(64) },
  }, tool(async (x: { messageId: string }) => readStatusOf(deps, a, x.messageId, await scope())) as never);
}
