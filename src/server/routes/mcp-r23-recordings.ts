/**
 * Round 23 (R23.2): a recorded call's transcript and summary on MCP. Read only keys and tokens can
 * read it (it only reads). Recording itself happens in the meeting room, by a person.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { listRecordings } from "../services/suite/meeting-recordings";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerRecordingTools(server: McpServer, deps: Deps, actor: Scoped, _writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  const ro = { readOnlyHint: true, openWorldHint: false };

  server.registerTool("get_meeting_transcript", {
    title: "Get a meeting's transcript and summary", annotations: ro,
    description: "The recordings of a meeting, newest first: status (recording, processing, done or failed), who recorded, duration in seconds, the summary, action items [{ text, assignee, due }] and the transcript text (capped at 200 KB; truncated says when it was cut). Calls are recorded and transcribed with the workspace's own speech to text key; Multies keeps the text, not the audio.",
    inputSchema: { meetingId: z.string().min(1) },
  }, tool(async (x: { meetingId: string }) => ({ meetingId: x.meetingId, recordings: await listRecordings(deps, a, x.meetingId) })) as never);
}
