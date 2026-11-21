/**
 * OPS1: the console's small states. Import them from ./format (it re-exports these).
 *
 *   <EmptyRow>No API keys yet.</EmptyRow>               one line inside a section card (a whole empty page or tab uses
 *                                                       the big EmptyState instead)
 *   <LoadError error={q.error} retry={() => void q.refetch()} what="the workspace" />
 *       403: "You don't have access to this page" (calm, no Try again)
 *       404: "<What> wasn't found"
 *       else: the server's own message, with Try again
 *   consoleErrorMessage(err)                            the words for any error (the server's message when it gave one)
 */
import type { ReactNode } from "react";
import { ApiError } from "@/web/lib/api";
import { Button } from "@/web/components/ui/button";
import { Card, EmptyState } from "@/web/components/ui/misc";
import { IconLock, IconSearch, IconWarning, IconWifiOff } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";

/** A one-line empty state for a sub-section inside a page. */
export function EmptyRow({ children, icon, action, className, testId }: { children: ReactNode; icon?: ReactNode; action?: ReactNode; className?: string; testId?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-line px-4 py-3 text-sm text-muted", className)} data-testid={testId ?? "console-empty-row"}>
      {icon && <span className="shrink-0 text-subtle [&_svg]:h-4 [&_svg]:w-4" aria-hidden>{icon}</span>}
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

/** True when the server said this role may not open it (403 that is not a sign in problem). */
export function isNoAccess(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403 && err.code !== "two_factor_required" && err.code !== "impersonating";
}

/** The words for an error: the server's own message whenever it sent one, a plain line when it could not be reached. */
export function consoleErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return "Couldn't reach Multies. Check your connection, then try again.";
    if (err.message) return err.message;
    return err.status >= 500 ? "Multies had a problem answering. Try again in a moment." : "Something went wrong. Try again.";
  }
  if (err instanceof TypeError) return "Couldn't reach Multies. Check your connection, then try again.";
  return err instanceof Error && err.message ? err.message : "Something went wrong. Try again.";
}

/** The calm card for a page the operator's role can't open. */
export function NoAccess({ className }: { className?: string }) {
  return (
    <Card className={cn("p-0", className)} data-testid="console-no-access">
      <EmptyState icon={<IconLock />} title="You don't have access to this page" body="Your operator role can't open this. An owner can change your role on the Operators page if you need it." />
    </Card>
  );
}

/** A failed read in a page, tab or list. Keep the page header and back link above it. */
export function LoadError({ error, retry, what = "this page", className }: { error: unknown; retry?: () => void; what?: string; className?: string }) {
  if (isNoAccess(error)) return <NoAccess className={className} />;
  const notFound = error instanceof ApiError && error.status === 404;
  const offline = error instanceof ApiError ? error.status === 0 : error instanceof TypeError;
  return (
    <Card className={cn("p-0", className)} data-testid="console-load-error">
      <EmptyState
        icon={notFound ? <IconSearch /> : offline ? <IconWifiOff /> : <IconWarning />}
        title={notFound ? `${what.charAt(0).toUpperCase()}${what.slice(1)} wasn't found` : `Couldn't load ${what}`}
        body={notFound ? "It may have been deleted, or the link is wrong." : consoleErrorMessage(error)}
        action={!notFound && retry ? <Button variant="secondary" onClick={retry}>Try again</Button> : undefined}
      />
    </Card>
  );
}
