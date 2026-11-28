/**
 * MPT-11 (NAV1 slice 2): the "N waiting in Triage" line above a project's tasks. On 24 Nov 2026 the MPT and MB boards
 * looked empty because every item waited in Triage, and the boards gave no hint of it.
 *
 * The line shows on the board and the list of one project when the project has Triage on and at least 1 item waits.
 * N is the pending count of that project (GET /api/triage/count?projectId=), without snoozed items. When the count read
 * fails (for example, no workspace session, the same rule as the Triage page), the line is hidden.
 */
export interface TriageWaitingInput {
  projectId: string | null | undefined;
  triageOn: boolean;
  view: string;
  count: number | undefined;
  failed: boolean;
}

export interface TriageWaitingLine { count: number; href: string }

const VIEWS = new Set(["board", "list"]);

export function triageWaitingLine(i: TriageWaitingInput): TriageWaitingLine | null {
  if (!i.projectId || !i.triageOn || i.failed || !VIEWS.has(i.view)) return null;
  const count = i.count ?? 0;
  if (count <= 0) return null;
  return { count, href: `/app/triage?project=${encodeURIComponent(i.projectId)}` };
}
