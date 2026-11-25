/**
 * R39 page history over MCP: list_doc_versions, read_doc_version, save_doc_version, restore_doc_version. Same service as
 * /api/v1/docs/{id}/versions (services/suite/doc-versions-r39.ts). An agent can see what changed on a page (its own
 * edits included) and put a page back.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { getDocVersion, listDocVersions, restoreDocVersion, saveDocVersion, VERSION_NAME_MAX } from "../services/suite/doc-versions-r39";
import type { Scoped } from "./mcp-server";
import { mcpCreate } from "./mcp-idempotency"; // R54 (MB-239)

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerDocVersionR39Tools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  server.registerTool("list_doc_versions", {
    title: "List a doc's page history", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "Saved versions of a doc, newest first: id, docVersion, title, name, reason (edit or restore), words, author { type, name } and savedAt, plus the page now (version, words, editedBy). A version is kept when a new editing session starts (10 minutes after the last save, or someone else edits), when someone saves one, and before every restore; the newest 50 unnamed ones per doc are kept, named ones always. Pass an id to read_doc_version to see it and what changed since.",
    inputSchema: { docId: z.string().min(1), limit: z.number().int().min(1).max(200).optional() },
  }, tool(async (x: { docId: string; limit?: number }) => {
    const r = await listDocVersions(deps, a, x.docId, { limit: x.limit });
    return { doc: r.doc, versions: r.versions.map((v) => ({ id: v.id, docVersion: v.docVersion, title: v.title, name: v.name, reason: v.reason, words: v.words, author: { type: v.author.type, name: v.author.name }, savedAt: v.savedAt })) };
  }) as never);

  server.registerTool("read_doc_version", {
    title: "Read one saved version of a doc", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "One version's title and plain text (content: true adds the Tiptap JSON), and sinceThen { added, removed, titleChanged }: the lines added and removed between that version and the page now. diff: true adds the line diff (type same, add or del; at most 2,000 lines).",
    inputSchema: { docId: z.string().min(1), versionId: z.string().min(1), diff: z.boolean().optional(), content: z.boolean().optional() },
  }, tool(async (x: { docId: string; versionId: string; diff?: boolean; content?: boolean }) => {
    const r = await getDocVersion(deps, a, x.docId, x.versionId, { diff: x.diff });
    const { content: _content, ...v } = r.version;
    return { version: x.content ? r.version : v, current: r.current, sinceThen: r.sinceThen, ...(x.diff ? { diff: r.diff, truncated: r.truncated } : {}) };
  }) as never);

  server.registerTool("save_doc_version", {
    title: "Save a doc as a named version", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: `Keeps the page as it is now under a name (up to ${VERSION_NAME_MAX} characters; left out: "Version N"), for example before a big rewrite. Named versions are never pruned. One row written.`,
    inputSchema: { docId: z.string().min(1), name: z.string().max(VERSION_NAME_MAX).optional() },
  }, tool(async (x: { docId: string; name?: string }) => {
    writable();
    return await saveDocVersion(deps, a, x.docId, { name: x.name }, await mcpCreate("dver"));
  }) as never);

  server.registerTool("restore_doc_version", {
    title: "Restore a saved version of a doc", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "Puts a doc back to a saved version (title and content). The page as it is now is saved first as a version (reason restore), so the restore can be undone by restoring that one. ifVersion (the doc version you read) makes it fail with version_conflict if the doc changed since. Two rows written.",
    inputSchema: { docId: z.string().min(1), versionId: z.string().min(1), ifVersion: z.number().int().positive().optional() },
  }, tool(async (x: { docId: string; versionId: string; ifVersion?: number }) => {
    writable();
    const r = await restoreDocVersion(deps, a, x.docId, x.versionId, { ifVersion: x.ifVersion });
    return { doc: { id: r.doc.id, title: r.doc.title, version: r.doc.version, text: r.doc.text }, restoredFrom: { id: r.restoredFrom.id, docVersion: r.restoredFrom.docVersion, name: r.restoredFrom.name }, savedCurrentAs: r.savedCurrentAs };
  }) as never);
}
