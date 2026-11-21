/**
 * OPS1: who may open the console, read from GET /api/console/me.
 *
 *   <ConsoleGuard>...</ConsoleGuard>          shows the page only to operators (skeleton while it loads; a plain card
 *                                             for everyone else; sign in when signed out)
 *   const me = useConsoleMe();                the operator (inside the guard)
 *   const canSuspend = usePermission("workspaces.suspend");
 *   <PermissionGate permission="billing.manage">{button}</PermissionGate>   hides what the role can't use
 *
 * The server checks every permission again; hiding is for a calm screen, not for safety.
 */
import { createContext, useContext, type ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ApiError, errorMessage } from "@/web/lib/api";
import { consoleApi, consoleKeys, type ConsoleMe } from "@/web/lib/console-api";
import { Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { Button, buttonClass } from "@/web/components/ui/button";
import { IconLock, IconShieldAlert, IconShieldCheck, IconWifiOff } from "@/web/components/ui/icon";
import type { Permission } from "@/shared/operator-permissions";

const MeContext = createContext<ConsoleMe | null>(null);

/** The console's own read of who is signed in. Not retried on 401 or 403 (they are answers, not failures). */
export function useConsoleMeQuery() {
  return useQuery({
    queryKey: consoleKeys.me,
    queryFn: consoleApi.me,
    staleTime: 60_000,
    retry: (n, err) => !(err instanceof ApiError && (err.status === 401 || err.status === 403)) && n < 1,
  });
}

/** The operator using the console. Only inside ConsoleGuard. */
export function useConsoleMe(): ConsoleMe {
  const me = useContext(MeContext);
  if (!me) throw new Error("useConsoleMe is only for pages inside ConsoleGuard.");
  return me;
}

/** Whether the operator's role has this permission (false outside the guard). */
export function usePermission(permission: Permission): boolean {
  const me = useContext(MeContext);
  return !!me?.permissions.includes(permission);
}

/** Shows its children only when the role has the permission; otherwise the fallback (nothing by default). */
export function PermissionGate({ permission, children, fallback = null }: { permission: Permission; children: ReactNode; fallback?: ReactNode }) {
  return <>{usePermission(permission) ? children : fallback}</>;
}

function Blocked({ icon, title, body, action }: { icon: ReactNode; title: string; body: ReactNode; action?: ReactNode }) {
  return (
    <div className="mx-auto max-w-lg px-4 pt-12 md:pt-20" data-testid="console-blocked">
      <h1 className="sr-only">Operator console</h1>
      <Card className="overflow-hidden p-0">
        <div className="h-1 bg-gradient-to-r from-brand via-brand/40 to-transparent" aria-hidden />
        <EmptyState icon={icon} title={title} body={body} action={action} />
      </Card>
    </div>
  );
}

const backToApp = <Link to="/app/my-work" className={buttonClass("primary", "md")}>Back to my work</Link>;

export function ConsoleGuard({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const q = useConsoleMeQuery();
  if (q.isPending) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 px-4 pt-10" role="status" aria-busy="true" aria-label="Loading the operator console">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }
  if (q.error) {
    const e = q.error;
    if (e instanceof ApiError && e.status === 401) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
    if (e instanceof ApiError && e.code === "two_factor_required") {
      return <Blocked icon={<IconLock />} title="Turn on two-step sign in first" body="The operator console needs two-step sign in on your account. Turn it on in your account settings, then sign in again." action={<Link to="/app/settings/account" className={buttonClass("primary", "md")}>Open account settings</Link>} />;
    }
    if (e instanceof ApiError && e.code === "impersonating") {
      return <Blocked icon={<IconShieldAlert />} title="You are viewing as someone else" body="Stop viewing as this person to open the operator console." action={backToApp} />;
    }
    if (e instanceof ApiError && e.status === 403) {
      return <Blocked icon={<IconShieldCheck />} title="This console is for platform operators" body="You can keep working in your workspace. If you need access to this console, ask an operator to add you." action={backToApp} />;
    }
    return <Blocked icon={<IconWifiOff />} title="Couldn't open the console" body={errorMessage(e)} action={<Button onClick={() => void q.refetch()}>Try again</Button>} />;
  }
  return <MeContext.Provider value={q.data}>{children}</MeContext.Provider>;
}
