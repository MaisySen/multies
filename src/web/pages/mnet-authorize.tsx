import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/web/components/ui/button";
import { Select } from "@/web/components/ui/input";
import { api, ApiError } from "@/web/lib/api";

interface LaunchInfo {
  email: string;
  request: { deviceKey: string; state: string; challenge: string; platform: string; redirectUri: string };
  workspaces: { id: string; name: string }[];
  truncated: boolean;
}

/** Explicit person approval only. Does not bootstrap membership or grant remote input. */
export function MnetAuthorizePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qs = params.toString();
  const [workspaceId, setWorkspaceId] = useState("");
  const [cancelled, setCancelled] = useState(false);
  const info = useQuery({ queryKey: ["mnet-authorize", qs], queryFn: () => api.get<LaunchInfo>(`/mnet/authorize?${qs}`), retry: false });
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
  const card = (children: React.ReactNode) => <section className="rounded-2xl border border-line bg-surface/80 p-7 shadow-pop backdrop-blur">{children}</section>;
  if (info.isPending || (info.error instanceof ApiError && info.error.status === 401)) return card(<p role="status">Checking Multies sign in...</p>);
  if (info.error) return card(<><h1 className="text-xl font-semibold">Mnet sign in is unavailable</h1><p role="alert" className="mt-3 text-sm text-muted">{info.error.message}</p><p className="mt-3 text-sm text-muted">Return to Mnet and start sign in again. Nothing was approved.</p></>);
  if (cancelled) return card(<><h1 className="text-xl font-semibold">Device not approved</h1><p className="mt-3 text-sm text-muted">You can close this tab. Mnet has no access from this request.</p></>);
  const d = info.data;
  return card(<>
    <h1 className="text-xl font-semibold tracking-tight">Connect Mnet to Multies</h1>
    <p className="mt-2 break-all text-sm text-muted">Signed in as {d.email}</p>
    <p className="mt-4 text-sm">Approve this {d.request.platform} device for your own Mnet device list. It cannot read your mail, access someone else's devices, view a screen or control a keyboard or mouse.</p>
    <div className="mt-4 rounded-xl border border-line p-3 text-sm"><p className="font-medium">Check the device key in Mnet</p><code className="mt-2 block break-all font-mono text-xs" data-testid="mnet-device-key">{d.request.deviceKey}</code><p className="mt-2 text-xs text-muted">Only continue if you started this request in Mnet and this key matches. Do not approve a link someone sent you.</p></div>
    {d.workspaces.length ? <label className="mt-5 block text-sm font-medium">Workspace<Select className="mt-1.5 w-full" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}><option value="">Choose a workspace</option>{d.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></label> : <p className="mt-4 text-sm text-muted">No existing workspace is eligible for this sign in. No workspace or membership was created.</p>}
    {d.truncated && <p className="mt-2 text-xs text-muted">Only the first 100 eligible workspaces are shown.</p>}
    {allow.error && <p role="alert" className="mt-4 text-sm text-bad">{allow.error.message} Return to Mnet and start again if this request expired.</p>}
    <div className="mt-6 flex gap-3"><Button variant="secondary" className="flex-1" disabled={allow.isPending || allow.isSuccess} onClick={() => { setCancelled(true); const target = new URL(d.request.redirectUri); target.searchParams.set("state", d.request.state); target.searchParams.set("error", "access_denied"); window.location.assign(target.href); }}>Cancel</Button><Button className="flex-1" disabled={!workspaceId || allow.isPending || allow.isSuccess} loading={allow.isPending} onClick={() => allow.mutate()}>Approve device</Button></div>
    <p className="mt-4 text-xs text-muted">Returns only to Mnet on this computer. Access lasts at most 10 minutes and ends if your Multies session or membership is revoked. Remote Desktop and Shared Desk need separate approval.</p>
  </>);
}
