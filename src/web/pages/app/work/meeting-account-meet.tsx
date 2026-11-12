/**
 * MEET fixes (12 Nov 2026): the account and workspace a meeting opens as, said out loud.
 *
 * - OtherWorkspace: a meeting link from another of the person's workspaces used to say "not found", which read
 *   as a broken link. The server now names the workspace (404 meeting_in_other_workspace) and this offers the
 *   switch, then opens the same meeting.
 * - useAccountKept: the phone app opens meetings in the phone's browser with a one time sign in. When that
 *   browser is already signed in as someone else it keeps its own account (it never swaps silently), and the
 *   page now says so, with the account it will join as and a way to sign out here (?account=kept).
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/web/lib/api";
import { Button } from "@/web/components/ui/button";
import { useMe } from "@/web/lib/queries";
import { workspaceTabs } from "@/web/lib/workspace-tabs-r58";
import { showError } from "@/web/lib/show-error";
import { clearOfflineData } from "@/web/lib/sw-client";
import { tr } from "@/web/i18n";
import "@/web/i18n/w2/en-meetings";

/** The other workspace named by the server's answer, if that is why the meeting didn't open. */
export function otherWorkspaceOf(error: unknown): { id: string; name: string } | null {
  if (!(error instanceof ApiError) || error.code !== "meeting_in_other_workspace") return null;
  const w = (error.details as { workspace?: { id?: unknown; name?: unknown } } | undefined)?.workspace;
  return w && typeof w.id === "string" && typeof w.name === "string" ? { id: w.id, name: w.name } : null;
}

export function OtherWorkspace({ error }: { error: unknown }) {
  const w = otherWorkspaceOf(error);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  if (!w) return null;
  const go = async () => {
    setBusy(true);
    try {
      await api.post(`/account/workspaces/${w.id}/switch`);
      workspaceTabs()?.switchedHere();
      qc.clear();
      window.location.reload();
    } catch (e) { showError(e as Error); setBusy(false); }
  };
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-line p-4 text-[13px]" data-testid="meeting-other-workspace">
      <p className="min-w-0 flex-1">{(error as Error).message}</p>
      <Button onClick={() => void go()} loading={busy} data-testid="meeting-switch-workspace">{tr("meetings.switch_and_open", { name: w.name })}</Button>
    </div>
  );
}

/** True when the page was opened from the app with ?account=kept (see auth/mobile-web-link.ts). */
export function accountWasKept(search: string) {
  return new URLSearchParams(search).get("account") === "kept";
}

/** The notice for ?account=kept, or null. */
export function useAccountKept() {
  const me = useMe();
  const [shown] = useState(() => typeof window !== "undefined" && accountWasKept(window.location.search));
  if (!shown || !me.data?.user) return null;
  const name = me.data.user.name || me.data.user.email;
  const workspace = me.data.organization?.name ?? "";
  const signOut = async () => {
    await clearOfflineData();
    try { await (await import("@/web/lib/auth-client")).authClient.signOut(); } catch { /* already signed out: the login page follows either way */ }
    const next = window.location.pathname + window.location.search.replace(/([?&])account=kept(&|$)/, "$1").replace(/[?&]$/, "");
    window.location.assign(`/login?next=${encodeURIComponent(next)}`);
  };
  return (
    <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-warn/20 bg-warn-soft p-3 text-[13px] text-fg" data-testid="meeting-account-kept">
      <p className="min-w-0 flex-1">{tr("meetings.account_kept", { name, workspace })}</p>
      <Button size="sm" variant="secondary" onClick={() => void signOut()} data-testid="meeting-account-sign-out">{tr("meetings.sign_out_here")}</Button>
    </div>
  );
}
