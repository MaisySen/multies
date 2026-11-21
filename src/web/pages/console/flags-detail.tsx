/**
 * OPS1: one feature flag, opened from the Feature flags list (?flag=<key> in the address, so it can be shared).
 * Shows what it does, its default from the deploy settings, the setting for everyone (owners can turn it on or off for
 * everyone, lock it, or go back to the default) and the workspaces with their own setting (ops admins can remove each).
 */
import { useState } from "react";
import { Link } from "react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Dialog } from "@/web/components/ui/dialog";
import { Badge, Card, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { IconBuilding, IconInfo } from "@/web/components/ui/icon";
import { EmptyRow, LoadError, PersonLink, RelTime } from "./components/format";
import { KvList } from "./components/kv-list";
import { useOperatorAction } from "./components/reason-dialog";
import { PermissionGate, usePermission } from "./guard";
import { flagKeys, flagsApi, type ConsoleFlag, type FlagWorkspaceOverride } from "./flags-api";
import { FlagState, platformSource } from "./flags-parts";
import { flagDef } from "@/shared/feature-flags";

const onOff = (v: boolean) => (v ? "On" : "Off");

function GlobalControls({ flag }: { flag: ConsoleFlag }) {
  const [lock, setLock] = useState(false);
  const canLock = flag.scope === "workspace";
  const set = useOperatorAction<boolean>({
    title: (v) => `Turn ${v ? "on" : "off"} ${flag.label} for everyone?`,
    description: (v) => (flag.scope === "workspace"
      ? `Every workspace gets ${v ? "On" : "Off"}${lock ? "" : ", except workspaces with their own setting"}. The default from deploy settings is ${onOff(flag.envDefault)}.`
      : `The whole platform gets ${v ? "On" : "Off"}. The default from deploy settings is ${onOff(flag.envDefault)}.`),
    confirmLabel: "Save for everyone",
    fields: canLock ? (
      <label className="flex items-start gap-2.5 text-sm">
        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--color-brand)]" checked={lock} onChange={(e) => setLock(e.target.checked)} data-testid="console-flags-lock" />
        <span>
          <span className="font-medium">Lock so workspaces cannot differ</span>
          <span className="block text-xs text-muted">Workspace settings are kept but have no effect while it is locked.</span>
        </span>
      </label>
    ) : undefined,
    run: (v, reason) => flagsApi.setGlobal(flag.key, { value: v, locked: canLock && lock, reason }),
    success: (v) => `${flag.label} turned ${v ? "on" : "off"} for everyone`,
  });
  const reset = useOperatorAction<void>({
    title: `Put ${flag.label} back to the default?`,
    description: `Everyone goes back to the default from deploy settings (${onOff(flag.envDefault)}). Workspaces with their own setting keep it.`,
    confirmLabel: "Back to default",
    run: (_v, reason) => flagsApi.clearGlobal(flag.key, reason),
    success: `${flag.label} is back to the default`,
  });
  const open = (v: boolean) => { setLock(!!flag.globalOverride?.locked); set.open(v); };
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" onClick={() => open(true)} data-testid="console-flags-global-on">Turn on for everyone</Button>
      <Button size="sm" variant="secondary" onClick={() => open(false)} data-testid="console-flags-global-off">Turn off for everyone</Button>
      <Button size="sm" variant="ghost" disabled={!flag.globalOverride} onClick={() => reset.open()} data-testid="console-flags-global-reset"
        title={flag.globalOverride ? undefined : "It already uses the default."}>Back to default</Button>
      {set.dialog}{reset.dialog}
    </div>
  );
}

function Overrides({ flag, pages, hasMore, loadingMore, loadMore }: {
  flag: ConsoleFlag; pages: FlagWorkspaceOverride[]; hasMore: boolean; loadingMore: boolean; loadMore: () => void;
}) {
  const canRemove = usePermission("flags.workspace");
  const remove = useOperatorAction<FlagWorkspaceOverride>({
    title: (o) => `Remove ${o.workspaceName ?? "this workspace"}'s own setting?`,
    description: () => `The workspace goes back to the setting for everyone (${onOff(flag.effective)} now).`,
    confirmLabel: "Remove setting", tone: "danger",
    run: (o, reason) => flagsApi.clearWorkspace(flag.key, o.orgId, reason),
    success: "Workspace setting removed",
  });
  if (flag.scope === "global") return <EmptyRow>This flag has one setting for the whole platform. Workspaces cannot have their own.</EmptyRow>;
  if (!pages.length) return <EmptyRow testId="console-flags-no-overrides">No workspace has its own setting. To give one a setting, open the workspace and its Flags tab.</EmptyRow>;
  return (
    <div>
      <ul className="divide-y divide-line rounded-xl border border-line" data-testid="console-flags-overrides">
        {pages.map((o) => (
          <li key={o.orgId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 text-sm">
            <span className="min-w-0 flex-1">
              <Link to={`/console/workspaces/${encodeURIComponent(o.orgId)}/flags`} title={o.orgId} className="font-medium hover:underline">{o.workspaceName ?? "Deleted workspace"}</Link>
              <span className="block text-xs text-subtle">
                <RelTime at={o.updatedAt} />{o.updatedByEmail ? ` by ${o.updatedByEmail}` : ""}{o.note ? `. ${o.note}` : ""}
              </span>
            </span>
            <Badge tone={o.value ? "ok" : "neutral"} dot>{onOff(o.value)}</Badge>
            {!o.applies && <Badge tone="warn" className="whitespace-nowrap">No effect while locked</Badge>}
            {canRemove && <Button size="sm" variant="ghost" onClick={() => remove.open(o)}>Remove</Button>}
          </li>
        ))}
      </ul>
      {hasMore && (
        <div className="mt-2 flex justify-end">
          <Button size="sm" variant="secondary" loading={loadingMore} onClick={loadMore}>Load more</Button>
        </div>
      )}
      {remove.dialog}
    </div>
  );
}

function Body({ flagKey }: { flagKey: string }) {
  const q = useInfiniteQuery({
    queryKey: flagKeys.detail(flagKey),
    queryFn: ({ pageParam }) => flagsApi.detail(flagKey, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.overrides.nextCursor,
  });
  if (q.isPending) {
    return <div className="space-y-3" role="status" aria-busy="true" aria-label="Loading the flag"><Skeleton className="h-32 rounded-xl" /><Skeleton className="h-9 w-72" /><Skeleton className="h-16 rounded-xl" /></div>;
  }
  if (q.error) {
    return <LoadError error={q.error} what="this flag" retry={() => void q.refetch()} />;
  }
  const flag = q.data.pages[0].flag;
  const g = flag.globalOverride;
  return (
    <div className="space-y-5 text-left" data-testid="console-flags-detail">
      <p className="text-sm text-muted">{flag.description}</p>
      <KvList items={[
        { label: "Now for everyone", value: <FlagState on={flag.effective} source={flag.runtime ? platformSource(g) : "default"} /> },
        { label: "Default from deploy settings", value: onOff(flag.envDefault), hint: <>Set by <span className="font-mono">{flag.env}</span></> },
        { label: "Applies to", value: flag.scope === "workspace" ? "Each workspace can have its own setting" : "The whole platform (one setting)" },
        { label: "Group", value: flag.group },
        ...(g ? [{ label: "Last changed", value: (
          <span className="inline-flex flex-wrap items-baseline gap-x-1">
            <RelTime at={g.updatedAt} />
            {g.updatedByEmail && <>by <PersonLink id={null} email={g.updatedByEmail} /></>}
          </span>
        ), hint: g.note ?? undefined }] : []),
      ]} />

      <section>
        <h3 className="mb-2 text-[13px] font-semibold">Setting for everyone</h3>
        {!flag.runtime ? (
          <Card className="flex items-start gap-2 p-3 text-sm text-muted">
            <IconInfo className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span><span className="font-medium text-fg">Set at deploy.</span> {flag.bootReason ?? "A change needs a deploy."} It cannot be changed here.</span>
          </Card>
        ) : (
          <PermissionGate permission="flags.global" fallback={<p className="text-sm text-muted">Only owners can change the setting for everyone.</p>}>
            <GlobalControls flag={flag} />
          </PermissionGate>
        )}
      </section>

      {flag.runtime && (
        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold"><IconBuilding className="h-3.5 w-3.5" aria-hidden />Workspaces with their own setting</h3>
          <Overrides flag={flag} pages={q.data.pages.flatMap((p) => p.overrides.items)} hasMore={q.hasNextPage}
            loadingMore={q.isFetchingNextPage} loadMore={() => void q.fetchNextPage()} />
        </section>
      )}
    </div>
  );
}

/** The flag named in the address; the title comes from the registry so it shows while the rest loads. */
export function FlagDetailDialog({ flagKey, onClose }: { flagKey: string | null; onClose: () => void }) {
  const def = flagKey ? flagDef(flagKey) : undefined;
  return (
    <Dialog open={!!flagKey} onClose={onClose} title={def?.label ?? "Feature flag"} className="sm:max-w-2xl">
      {flagKey && <Body flagKey={flagKey} />}
    </Dialog>
  );
}
