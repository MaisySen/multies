/** OPS1: small pieces shared by the Feature flags page, its detail and a workspace's Flags tab. */
import { Badge } from "@/web/components/ui/misc";
import { IconClock, IconInfo, IconLock } from "@/web/components/ui/icon";
import type { FlagSource } from "./flags-api";

const SOURCE_TEXT: Record<FlagSource, string> = {
  default: "default",
  global: "changed for everyone",
  locked: "locked for everyone",
  workspace: "this workspace",
};

/** On or Off, and where the value comes from. */
export function FlagState({ on, source, testId }: { on: boolean; source: FlagSource; testId?: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" data-testid={testId}>
      <Badge tone={on ? "ok" : "neutral"} dot>{on ? "On" : "Off"}</Badge>
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-muted">
        {source === "locked" && <IconLock className="h-3 w-3" aria-hidden />}
        {SOURCE_TEXT[source]}
      </span>
    </span>
  );
}

/** A muted "Set at deploy" with the reason in a tooltip (and for screen readers). */
export function DeployNote({ reason }: { reason: string | null }) {
  const why = reason ?? "This flag is read when the server starts, so a change needs a deploy.";
  return (
    <span className="inline-flex cursor-help items-center gap-1 whitespace-nowrap text-xs text-subtle" title={why} tabIndex={0} aria-label={`Set at deploy. ${why}`} data-testid="console-flags-deploy-note">
      <IconInfo className="h-3 w-3" aria-hidden />
      Set at deploy
    </span>
  );
}

/** The always visible note that a change is not instant everywhere. */
export function PropagationNote() {
  return (
    <p className="mb-4 flex items-start gap-2 rounded-lg border border-line bg-fill/60 px-3 py-2 text-[13px] text-muted" data-testid="console-flags-propagation">
      <IconClock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>Changes can take up to a minute to reach every server.</span>
    </p>
  );
}

/** Where a platform value comes from, for the list and the detail. */
export const platformSource = (g: { locked: boolean } | null): FlagSource => (g ? (g.locked ? "locked" : "global") : "default");
