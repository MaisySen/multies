import { ApiError } from "@/api/errors";
import type { AgentRun, RunStep } from "@/api/types";
import type { SampleWork } from "./tasks";

/** R29: agent runs in the sample workspace, shaped like the server's (R27 agent runs). */

const AGENT = { userId: "usr_agent_books", name: "Bookkeeper", avatarColor: "#0071E3", isAgent: true as const };

export function sampleRuns(now: number, work: SampleWork): AgentRun[] {
  const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
  const task = (prefix: string) => work.tasks.find((t) => t.title.startsWith(prefix));
  const run = (id: string, prefix: string, status: AgentRun["status"], startMin: number | null, endMin: number | null, steps: [number, RunStep["kind"], string][], result: string | null): AgentRun | null => {
    const t = task(prefix);
    if (!t) return null;
    const startedAt = startMin === null ? null : at(startMin);
    const finishedAt = endMin === null ? null : at(endMin);
    return {
      id, taskId: t.id, task: { ref: t.ref, title: t.title }, agent: AGENT, status, startedAt, finishedAt,
      durationMs: startedAt && finishedAt ? Date.parse(finishedAt) - Date.parse(startedAt) : null,
      result, stepCount: steps.length, steps: steps.map(([m, kind, text]) => ({ at: at(m), kind, text })),
      createdAt: at((startMin ?? 1) + 0.5), updatedAt: at(endMin ?? 0), triggerId: null,
    };
  };
  return [
    run("run_s4", "Lodge the September quarter BAS", "running", 6, null, [
      [6, "note", "Started on the BAS checklist."],
      [5, "tool", "Read 214 bank feed lines for July to September."],
      [3, "note", "Matched 209 lines. Five card payments need a receipt."],
    ], null),
    run("run_s3", "Chase INV-1042 with Green Roof Cafe", "succeeded", 95, 91.75, [
      [95, "note", "Checked INV-1042: $1,840, 12 days overdue."],
      [94, "tool", "Found the remittance email from Li at Green Roof Cafe."],
      [93, "tool", "Matched $1,840 in the bank feed on Friday."],
      [92, "status_change", "Moved the task to Done."],
    ], "INV-1042 is paid in full. The remittance matches the Friday deposit, so nothing more to chase."),
    run("run_s2", "Compare fit out quotes for the Surry Hills kiosk", "failed", 60 * 26, 60 * 26 - 2, [
      [60 * 26, "note", "Looked for the three fit out quotes."],
      [60 * 26 - 1, "tool", "Only one quote is attached to the task."],
    ], "Couldn't compare: two of the three quotes are missing. Attach them and run me again."),
    run("run_s1", "Confirm Saturday wholesale order with Bondi Bakehouse", "queued", null, null, [], null),
  ].filter((r): r is AgentRun => !!r);
}

/** Answers /agent-runs, /agent-runs/:id and /tasks/:id/runs. Undefined when the path is something else. */
export function runsRoute(runs: AgentRun[], work: SampleWork, method: string, parts: string[], params: Record<string, string>): unknown {
  if (method !== "GET") return undefined;
  const newest = (list: AgentRun[]) => [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (parts[0] === "agent-runs" && parts.length === 1) {
    const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 200);
    const list = runs.filter((r) => (!params.status || r.status === params.status) && (!params.agentUserId || r.agent.userId === params.agentUserId));
    return { runs: newest(list).slice(0, limit).map((r) => ({ ...r, steps: [] })) };
  }
  if (parts[0] === "agent-runs" && parts.length === 2) {
    const r = runs.find((x) => x.id === decodeURIComponent(parts[1]));
    if (!r) throw new ApiError(404, "not_found", "Run not found.");
    return { run: r };
  }
  if (parts[0] === "tasks" && parts.length === 3 && parts[2] === "runs") {
    const key = decodeURIComponent(parts[1]);
    const t = work.tasks.find((x) => x.id === key || x.ref === key);
    if (!t) throw new ApiError(404, "not_found", "Task not found.");
    return { taskId: t.id, ref: t.ref, runs: newest(runs.filter((r) => r.taskId === t.id)) };
  }
  return undefined;
}
