import type { Assignee } from "@/api/types";

/**
 * Round 2 (PR 23): an assignee that is an AI, as on the web (work/data.ts isAgentLike): a mail agent, an AI agent
 * member, or a member whose address is an agent's inbox (the server marks those isAgent).
 */
export const isAgentLike = (p: Pick<Assignee, "type"> & { isAgent?: boolean }) => p.type === "agent" || !!p.isAgent;

/** How a picker and the task screen name an assignee: "(agent)" after an AI's name, as on the web. */
export const assigneeLabel = (p: Pick<Assignee, "type" | "name"> & { isAgent?: boolean }) => (isAgentLike(p) ? `${p.name} (agent)` : p.name);

/** Who a picker offers: paused AIs are left out, except the one a task already has (so it still reads right). */
export function pickable<T extends Pick<Assignee, "id"> & { paused?: boolean }>(list: readonly T[], keep?: string | null): T[] {
  return list.filter((p) => !p.paused || p.id === keep);
}
