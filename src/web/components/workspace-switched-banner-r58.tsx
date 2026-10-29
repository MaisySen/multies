/**
 * R58 (MB-245): when this tab is behind a workspace switch made in another tab, one calm strip says so and offers
 * Reload. Saves from this tab are stopped before they are sent (workspace-tabs-r58.ts). Reload copies any text typed
 * into an open dialog first and opens the workspace now active; the next page says the text is on the clipboard.
 */
import { useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Button } from "@/web/components/ui/button";
import type { Me } from "@/web/lib/types";
import { CARRY_KEY, typedText, workspaceTabs, type Behind } from "@/web/lib/workspace-tabs-r58";

const noop = () => () => {};
export function useBehindWorkspace(): Behind | null {
  const wt = workspaceTabs();
  return useSyncExternalStore(wt ? wt.subscribe : noop, () => wt?.behind() ?? null, () => null);
}

/** Announces the workspace this tab shows, once it is known and whenever this tab opens another one. */
export function useAnnounceWorkspace(org: Me["organization"] | null | undefined): void {
  useEffect(() => { if (org?.id) workspaceTabs()?.adopt(org.id, org.name); }, [org?.id, org?.name]);
  // After a Reload that carried typed text, say where it went (once).
  useEffect(() => {
    let carried: string | null = null;
    try { carried = sessionStorage.getItem(CARRY_KEY); sessionStorage.removeItem(CARRY_KEY); } catch { /* blocked */ }
    if (carried) toast.success("What you typed before reloading is copied. Paste it to carry on.", { id: "carried-text", duration: 12_000 });
  }, []);
}

export async function reloadKeepingText(): Promise<void> {
  const text = typeof document !== "undefined" ? typedText(document) : "";
  if (text) {
    try { await navigator.clipboard.writeText(text); sessionStorage.setItem(CARRY_KEY, "1"); } catch { /* no clipboard: the text stays in this tab, so ask first */
      if (!window.confirm("Reloading clears what you typed in this tab. Copy it first if you need it. Reload now?")) return;
    }
  }
  // Open the workspace that is active now; a page of the old one (a project, a doc) would not open there.
  window.location.assign("/app");
}

export function WorkspaceSwitchedBanner() {
  const behind = useBehindWorkspace();
  if (!behind) return null;
  return (
    <div role="alert" data-testid="workspace-switched-banner" className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5 text-[13px]">
      <p className="min-w-0 flex-1 text-fg">
        <span className="font-medium">You switched to {behind.name || "another workspace"} in another tab.</span>{" "}
        <span className="text-muted">Saving is paused here until you reload.</span>
      </p>
      <Button size="sm" onClick={() => void reloadKeepingText()} data-testid="workspace-switched-reload">Reload</Button>
    </div>
  );
}
