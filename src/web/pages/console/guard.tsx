/**
 * OPS1: who may open the console, read from GET /api/console/me.
 *
 *   <ConsoleGuard>...</ConsoleGuard>          shows the page only to operators (skeleton while it loads; a plain card
 *                                             for everyone else; sign in when signed out)
 *   const me = useConsoleMe();                the operator (inside the guard)
 *   const canSuspend = usePermission("workspaces.suspend");
 *   <PermissionGate permission="billing.manage">{button}</PermissionGate>   hides what the role can't use
 *   <RequirePermission permission="operators.read">{page body}</RequirePermission>  a page the role can't open shows
 *                                             "You don't have access to this page" instead (no request is made)
 *
 * The server checks every permission again; hiding is for a calm screen, not for safety.
 */
import { createContext, useContext, useState, type ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { consoleApi, consoleKeys, type ConsoleMe } from "@/web/lib/console-api";
import { Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { Button, buttonClass } from "@/web/components/ui/button";
import { IconLock, IconShieldAlert, IconShieldCheck, IconWifiOff } from "@/web/components/ui/icon";
import type { Permission } from "@/shared/operator-permissions";
import { NoAccess, consoleErrorMessage } from "./components/states";

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

/** A page (or a part of one) only for roles with this permission; others see the calm "no access" card. */
export function RequirePermission({ permission, children }: { permission: Permission; children: ReactNode }) {
  return <>{usePermission(permission) ? children : <NoAccess />}</>;
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

/** Signs out and opens sign in, coming back to `next` afterwards (as the step-up dialog's Sign in again does). */
function SignInAgain({ next }: { next: string }) {
  const [busy, setBusy] = useState(false);
  const again = async () => {
    setBusy(true);
    try {
      const { authClient } = await import("@/web/lib/auth-client");
      await authClient.signOut();
    } catch (e) {
      // Already signed out is fine; anything else is shown, and sign in still opens.
      if (e instanceof Error && !/sign|session/i.test(e.message)) showError(e);
    }
    window.location.assign(`/login?next=${encodeURIComponent(next)}`);
  };
  return <Button loading={busy} onClick={() => void again()} data-testid="console-sign-in-again">Sign in again</Button>;
}

/**
 * The two-step refusal (403 two_factor_required). The server says why in details.reason: two-step is off on the account
 * (not_enrolled), or it is on but this session never gave a code (no_second_factor_this_session: a sign in through
 * Google or another outside account, or a remembered device). The fix differs, so the card does too.
 */
function TwoStepRefusal({ reason }: { reason: unknown }) {
  if (reason === "not_enrolled") {
    return (
      <Blocked icon={<IconLock />} title="Turn on two-step sign in"
        body="The operator console needs two-step sign in on your account. Turn it on in your account security settings, then come back here: the session you turn it on in opens the console."
        action={(
          <span className="flex flex-wrap justify-center gap-2">
            <Link to="/app/settings/account" className={buttonClass("primary", "md")} data-testid="console-two-step-settings">Open account security</Link>
            {/* A full load, so the console asks the server again. */}
            <a href="/console" className={buttonClass("secondary", "md")} data-testid="console-two-step-retry">Open the console</a>
          </span>
        )} />
    );
  }
  return (
    <Blocked icon={<IconLock />} title="Sign in again with your two-step code"
      body={reason === "no_second_factor_this_session"
        ? "Two-step sign in is on for your account, but this session didn't give a code. That happens after a sign in through Google or another outside account, or on a remembered device. Sign in again with your password and two-step code (or a passkey) to open the console."
        : "The operator console needs a sign in with your password and two-step code (or a passkey). If two-step sign in is off, turn it on in your account security settings first."}
      action={<SignInAgain next="/console" />} />
  );
}

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
      return <TwoStepRefusal reason={(e.details as { reason?: unknown } | undefined)?.reason} />;
    }
    if (e instanceof ApiError && e.code === "impersonating") {
      return (
        <Blocked icon={<IconShieldAlert />} title="You are viewing as someone else"
          body="The console is closed while you view as another person. Go back to the app and choose Stop in the bar at the top to return to your own account."
          action={<Link to="/app/my-work" className={buttonClass("primary", "md")}>Back to the app</Link>} />
      );
    }
    if (e instanceof ApiError && e.status === 403) {
      return <Blocked icon={<IconShieldCheck />} title="This console is for platform operators" body="You can keep working in your workspace. If you need access to this console, ask an operator to add you." action={backToApp} />;
    }
    return <Blocked icon={<IconWifiOff />} title="Couldn't open the console" body={consoleErrorMessage(e)} action={<Button onClick={() => void q.refetch()}>Try again</Button>} />;
  }
  return <MeContext.Provider value={q.data}>{children}</MeContext.Provider>;
}
