/** OPS1: small pieces shared by the Feature flags page, its detail and a workspace's Flags tab. */
import type { ReactNode } from "react";
import { Badge } from "@/web/components/ui/misc";
import { IconClock, IconLock } from "@/web/components/ui/icon";
import type { FlagBlocked, FlagSource } from "./flags-api";

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
      <Badge tone={on ? "ok" : "neutral"} dot className="whitespace-nowrap">{on ? "On" : "Off"}</Badge>
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-muted">
        {source === "locked" && <IconLock className="h-3 w-3" aria-hidden />}
        {SOURCE_TEXT[source]}
      </span>
    </span>
  );
}

/**
 * A small grey tag for something that cannot be changed from where it shows ("Platform only", "Locked", "Set at
 * deploy"). The why is in the title (and read out with the tag), so the row stays one line.
 */
export function FlagTag({ children, why, testId }: { children: ReactNode; why: string; testId?: string }) {
  return (
    <span className="inline-flex cursor-help whitespace-nowrap rounded-full border border-line bg-fill px-2 py-0.5 text-[11.5px] font-medium leading-4 text-muted"
      title={why} tabIndex={0} aria-label={`${String(children)}. ${why}`} data-testid={testId}>
      {children}
    </span>
  );
}

const DEPLOY_WHY = "This flag is read when the server starts, so a change needs a deploy.";

/** "Set at deploy" with the reason in the title. */
export function DeployNote({ reason }: { reason: string | null }) {
  return <FlagTag why={reason ?? DEPLOY_WHY} testId="console-flags-deploy-note">Set at deploy</FlagTag>;
}

export const PLATFORM_ONLY_WHY = "This flag has one setting for the whole platform. Workspaces cannot have their own.";

/** The tag a workspace row shows instead of a change button, from the server's `blocked` field. */
export function BlockedTag({ blocked, bootReason, testId }: { blocked: Exclude<FlagBlocked, null>; bootReason: string | null; testId?: string }) {
  if (blocked === "deploy") {
    return <FlagTag why={`${bootReason ?? DEPLOY_WHY} It cannot be changed for one workspace.`} testId={testId}>Set at deploy</FlagTag>;
  }
  if (blocked === "global_only") {
    return <FlagTag why={`${PLATFORM_ONLY_WHY} Change it on the Feature flags page.`} testId={testId}>Platform only</FlagTag>;
  }
  return <FlagTag why="Locked for everyone, so workspaces cannot differ. An owner can remove the lock on the Feature flags page." testId={testId}>Locked</FlagTag>;
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
