/**
 * R73 (MB-270): the status page headline follows what is actually affected. When only background work (the queue) is
 * slower than usual, the headline says the core services work, instead of "Some things are slow or failing".
 */
export type ComponentState = "operational" | "degraded" | "down" | "not_configured";
const BACKGROUND = new Set(["queue"]);

export function statusHeadline(overall: "operational" | "degraded" | "down", components: { id: string; state: ComponentState }[]): string {
  if (overall === "operational") return "Everything is working.";
  const hit = components.filter((c) => c.state === "degraded" || c.state === "down");
  const onlyBackground = hit.length > 0 && hit.every((c) => BACKGROUND.has(c.id));
  if (onlyBackground) return hit.some((c) => c.state === "down") ? "All core services are working. Background work is paused for now." : "All core services are working. Some background work is slower than usual.";
  if (overall === "down") return "Part of Multies is down.";
  return hit.length === 1 ? "One part of Multies is slower than usual." : "Some things are slow or failing.";
}
