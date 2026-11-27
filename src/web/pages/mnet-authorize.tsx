import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/web/components/ui/button";
import { Select } from "@/web/components/ui/input";
import { api, ApiError } from "@/web/lib/api";

interface LaunchInfo {
  email: string;
  request: { deviceKey: string; state: string; challenge: string; platform: "linux" | "windows" | "macos"; redirectUri: string };
  workspaces: { id: string; name: string }[];
  truncated: boolean;
}

export function MnetAuthorizePage() {
  const [params] = useSearchParams();
  const qs = params.toString();
  return <MnetAuthorization key={qs} qs={qs} />;
}

/** Explicit person approval only. Does not bootstrap membership or grant remote input. */
function MnetAuthorization({ qs }: { qs: string }) {
  const navigate = useNavigate();
  const [workspaceId, setWorkspaceId] = useState("");
  const [keyMatches, setKeyMatches] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [readId] = useState(() => crypto.randomUUID());
  const info = useQuery({ queryKey: ["mnet-authorize", qs, readId], gcTime: 0, queryFn: () => api.get<LaunchInfo>(`/mnet/authorize?${qs}`), retry: false });
  useEffect(() => {
    if (info.error instanceof ApiError && info.error.status === 401) navigate(`/login?next=${encodeURIComponent(`/mnet/authorize?${qs}`)}`, { replace: true });
  }, [info.error, navigate, qs]);
  const allow = useMutation({
    mutationFn: async () => {
      const prepared = await api.post<{ id: string }>("/mnet/authorizations", { ...info.data!.request, workspaceId });
      return api.post<{ redirectTo: string }>(`/mnet/authorizations/${prepared.id}/decision`, { decision: "allow" });
    },
    onSuccess: (r) => { window.location.assign(r.redirectTo); },
  });
  const card = (children: React.ReactNode) => <section className="rounded-2xl border border-line bg-surface p-5 shadow-pop sm:p-7">{children}</section>;
  if (info.isPending || info.fetchStatus !== "idle" || (info.error instanceof ApiError && info.error.status === 401)) return card(<p role="status">Checking Multies sign in...</p>);
  if (info.error) return card(<><h1 className="text-xl font-semibold">Mnet sign in is unavailable</h1><p role="alert" className="mt-3 text-sm text-muted">{info.error.message}</p><p className="mt-3 text-sm text-muted">Return to Mnet and start sign in again. Nothing was approved.</p></>);
  if (cancelled) return card(<><h1 className="text-xl font-semibold">Device not approved</h1><p className="mt-3 text-sm text-muted">You can close this tab. Mnet has no access from this request.</p></>);
  const d = info.data;
  const platform = { linux: "Linux", windows: "Windows", macos: "macOS" }[d.request.platform] ?? d.request.platform;
  return card(<>
    <h1 className="text-2xl font-semibold tracking-tight">Connect Mnet to Multies</h1>
    <p className="mt-2 break-all text-sm text-muted">Signed in as {d.email}</p>
    <div className="mt-5 rounded-xl border border-line bg-fill/40 p-3.5 text-sm">
      <p className="font-medium">Device list access · {platform}</p>
      <p className="mt-1 text-muted">See your own Mnet devices in the workspace you choose for up to 10 minutes. Screen sharing, remote control and file access require separate permission.</p>
    </div>
    <form onSubmit={(event) => { event.preventDefault(); if (workspaceId && keyMatches && !allow.isPending && !allow.isSuccess) allow.mutate(); }}>
      {d.workspaces.length ? <div className="mt-5">
        <label htmlFor="mnet-workspace" className="block text-sm font-medium">Workspace</label>
        <Select id="mnet-workspace" required className="mt-1.5 w-full" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
          <option value="">Choose a workspace</option>
          {d.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
        </Select>
      </div> : <p className="mt-5 text-sm text-muted">This account has no eligible workspace. Return to Mnet and sign in with an account that belongs to your workspace.</p>}
      {d.truncated && <p className="mt-2 text-xs text-muted">Only the first 100 eligible workspaces are shown.</p>}
      {d.workspaces.length > 0 && <div className="mt-5 text-sm">
        <p className="font-medium">Verify this device</p>
        <p className="mt-1 text-muted">Compare this key with the one displayed in Mnet on this computer.</p>
        <code className="mt-2 block break-all rounded-lg border border-line px-2 py-2.5 font-mono text-xs" data-testid="mnet-device-key">{d.request.deviceKey}</code>
        <label className="mt-2 flex min-h-11 cursor-pointer items-center gap-3">
          <input type="checkbox" required checked={keyMatches} onChange={(event) => setKeyMatches(event.target.checked)} className="h-4 w-4 shrink-0 accent-[var(--brand)]" />
          <span>I started this request and the key matches.</span>
        </label>
      </div>}
      {allow.error && <p role="alert" className="mt-4 text-sm text-bad">{allow.error.message} Return to Mnet and start again if this request expired.</p>}
      {allow.isSuccess && <p role="status" className="mt-4 text-sm">Device approved. Returning to Mnet on this computer…</p>}
      <div className="mt-5 grid grid-cols-2 gap-3">
        <Button variant="secondary" disabled={allow.isPending || allow.isSuccess} onClick={() => {
          setCancelled(true);
          const target = new URL(d.request.redirectUri);
          target.searchParams.set("state", d.request.state);
          target.searchParams.set("error", "access_denied");
          window.location.assign(target.href);
        }}>Cancel</Button>
        <Button type="submit" disabled={!workspaceId || !keyMatches || allow.isSuccess} loading={allow.isPending}>Approve device</Button>
      </div>
    </form>
    <Link to="/mnet/devices" className="mt-3 inline-flex min-h-11 items-center text-sm text-accent underline-offset-4 hover:underline">Manage device approvals</Link>
  </>);
}
