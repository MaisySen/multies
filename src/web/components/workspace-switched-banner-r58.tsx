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
  // After a Reload that carried typed text, say where it went (once), when the app has loaded and the toast host is up.
  const ready = !!org?.id;
  useEffect(() => {
    if (!ready) return;
    let carried: { copied?: boolean; text?: string } | null = null;
    try { carried = JSON.parse(sessionStorage.getItem(CARRY_KEY) ?? "null"); sessionStorage.removeItem(CARRY_KEY); } catch { /* blocked or old */ }
    const text = carried?.text;
    if (!text) return;
    const words = carried?.copied ? "What you typed before reloading is copied. Paste it to carry on." : "What you typed before reloading is kept. Copy it to carry on.";
    const t = setTimeout(() => toast.success(words, {
      id: "carried-text", duration: 20_000,
      action: { label: "Copy", onClick: () => { void navigator.clipboard?.writeText(text).catch(() => undefined); } },
    }), 250);
    return () => clearTimeout(t);
  }, [ready]);
}

export async function reloadKeepingText(): Promise<void> {
  const text = typeof document !== "undefined" ? typedText(document) : "";
  if (text) {
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; } catch { /* no clipboard here: the next page offers Copy */ }
    // The text itself rides to the next page (this tab only), so it is never lost even without a clipboard.
    try { sessionStorage.setItem(CARRY_KEY, JSON.stringify({ copied, text })); } catch { /* blocked */ }
  }
  // Open the workspace that is active now; a page of the old one (a project, a doc) would not open there.
  window.location.assign("/app");
}

/** `dialog`: the same strip at the top of an open dialog, which makes the rest of the page inert while it is open. */
export function WorkspaceSwitchedBanner({ variant = "page" }: { variant?: "page" | "dialog" }) {
  const behind = useBehindWorkspace();
  if (!behind) return null;
  const sfx = variant === "dialog" ? "-dialog" : "";
  return (
    <div role="alert" data-testid={`workspace-switched-banner${sfx}`} className={variant === "dialog"
      ? "flex items-center gap-3 border-b border-line bg-fill/60 px-6 py-2.5 text-[13px]"
      : "flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5 text-[13px]"}>
      <p className="min-w-0 flex-1 text-fg">
        <span className="font-medium">You switched to {behind.name || "another workspace"} in another tab.</span>{" "}
        <span className="text-muted">Saving is paused here until you reload.</span>
      </p>
      <Button size="sm" onClick={() => void reloadKeepingText()} data-testid={`workspace-switched-reload${sfx}`}>Reload</Button>
    </div>
  );
}
