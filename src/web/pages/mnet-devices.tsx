import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, ButtonLink } from "@/web/components/ui/button";
import { api, ApiError } from "@/web/lib/api";

interface Device { id: string; deviceKey: string; platform: "linux" | "windows" | "macos"; workspace: string; expiresAt: string }
export function MnetDevicesPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [readId] = useState(() => crypto.randomUUID());
  const devices = useQuery({ queryKey: ["mnet-approved", readId], gcTime: 0, queryFn: () => api.get<{ devices: Device[]; truncated: boolean }>("/mnet/approved-devices"), retry: false, refetchOnWindowFocus: true, refetchInterval: 30_000 });
  useEffect(() => { if (devices.error instanceof ApiError && devices.error.status === 401) navigate("/login?next=%2Fmnet%2Fdevices", { replace: true }); }, [devices.error, navigate]);
  const revoke = useMutation({ mutationFn: (id: string) => api.del(`/mnet/devices/${id}`), onSettled: () => client.invalidateQueries({ queryKey: ["mnet-approved"] }) });
  const visible = !devices.error && devices.fetchStatus === "idle" && !revoke.isPending ? devices.data : undefined;
  return <section className="rounded-2xl border border-line bg-surface p-5 shadow-pop sm:p-7">
    <h1 className="text-2xl font-semibold tracking-tight">Mnet device approvals</h1>
    <p className="mt-2 text-sm text-muted">Manage access to your own Mnet device list. Approvals expire after 10 minutes. You can revoke access sooner from here.</p>
    {revoke.isPending ? <p className="mt-5 text-sm" role="status">Revoking approval…</p> :
      (devices.isPending || devices.fetchStatus !== "idle") && <p className="mt-5 text-sm" role="status">Checking approvals…</p>}
    {devices.error && <p className="mt-5 text-sm text-bad" role="alert">{devices.error.message} Use Check again to refresh approvals.</p>}
    {visible && !visible.devices.length && <div className="mt-5 rounded-xl border border-line bg-fill/40 p-4 text-sm">
      <p className="font-medium">No active approvals</p>
      <p className="mt-1 text-muted">Open Mnet on the computer you want to approve and start Multies sign-in there.</p>
    </div>}
    {visible && visible.devices.length > 0 && <ul className="mt-5 space-y-3">{visible.devices.map((device) => {
      const platform = { linux: "Linux", windows: "Windows", macos: "macOS" }[device.platform] ?? device.platform;
      return <li key={device.id} className="rounded-xl border border-line p-4">
        <p className="break-words text-sm font-medium">{platform} · {device.workspace}</p>
        <code className="mt-2 block break-all font-mono text-xs text-muted">{device.deviceKey}</code>
        <p className="mt-2 text-xs text-muted">Expires <time dateTime={device.expiresAt}>{new Date(device.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</time></p>
        <Button variant="danger" className="mt-3" aria-label={`Revoke approval for ${platform} in ${device.workspace}, key ending ${device.deviceKey.slice(-6)}`} onClick={() => revoke.mutate(device.id)}>Revoke approval</Button>
      </li>;
    })}</ul>}
    {visible?.truncated && <p className="mt-3 text-xs text-muted">Only the first 100 active approvals are shown.</p>}
    {revoke.error && <p role="alert" className="mt-4 text-sm text-bad">{revoke.error.message}</p>}
    {revoke.isSuccess && <p role="status" className="mt-4 text-sm">Device approval revoked.</p>}
    <div className="mt-5 flex flex-wrap gap-2">
      <Button variant="secondary" disabled={devices.fetchStatus !== "idle" || revoke.isPending} onClick={() => void devices.refetch()}>Check again</Button>
      <ButtonLink to="/app" variant="ghost">Back to Multies</ButtonLink>
    </div>
  </section>;
}
