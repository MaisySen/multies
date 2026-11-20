import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/web/components/ui/button";
import { api, ApiError } from "@/web/lib/api";

interface Device { id: string; deviceKey: string; platform: string; workspace: string; expiresAt: string }
export function MnetDevicesPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [readId] = useState(() => crypto.randomUUID());
  const devices = useQuery({ queryKey: ["mnet-approved", readId], gcTime: 0, queryFn: () => api.get<{ devices: Device[]; truncated: boolean }>("/mnet/approved-devices"), retry: false, refetchOnWindowFocus: true, refetchInterval: 30_000 });
  useEffect(() => { if (devices.error instanceof ApiError && devices.error.status === 401) navigate("/login?next=%2Fmnet%2Fdevices", { replace: true }); }, [devices.error, navigate]);
  const revoke = useMutation({ mutationFn: (id: string) => api.del(`/mnet/devices/${id}`), onSettled: () => client.invalidateQueries({ queryKey: ["mnet-approved"] }) });
  const visible = !devices.error && devices.fetchStatus === "idle" && !revoke.isPending ? devices.data : undefined;
  return <section className="rounded-2xl border border-line bg-surface/80 p-7 shadow-pop backdrop-blur">
    <h1 className="text-xl font-semibold">Your approved Mnet devices</h1>
    <p className="mt-3 text-sm text-muted">These are your current short-lived approvals, not proof that a device is online. Each approval lasts at most 10 minutes. No Remote Desktop or Shared Desk control is granted.</p>
    {(devices.isPending || devices.fetchStatus !== "idle") && <p className="mt-4 text-sm" role="status">Checking approvals...</p>}
    {devices.error && <p className="mt-4 text-sm text-bad" role="alert">{devices.error.message}</p>}
    {visible && !visible.devices.length && <p className="mt-5 text-sm">No active device approvals. Start sign in from Mnet to approve this computer.</p>}
    <ul className="mt-5 space-y-3">{visible?.devices.map((d) => <li key={d.id} className="rounded-xl border border-line p-3"><p className="text-sm font-medium">{d.platform} · {d.workspace}</p><code className="mt-2 block break-all text-xs">{d.deviceKey}</code><p className="mt-2 text-xs text-muted">Expires {new Date(d.expiresAt).toLocaleTimeString()}</p><Button variant="secondary" className="mt-3" disabled={revoke.isPending} onClick={() => revoke.mutate(d.id)}>Revoke approval</Button></li>)}</ul>
    {visible?.truncated && <p className="mt-3 text-xs text-muted">Only the first 100 active approvals are shown.</p>}
    {revoke.error && <p role="alert" className="mt-3 text-sm text-bad">{revoke.error.message}</p>}
    <Button variant="secondary" className="mt-4 mr-4" disabled={devices.fetchStatus !== "idle" || revoke.isPending} onClick={() => void devices.refetch()}>Check again</Button>
    <Link to="/app" className="mt-5 inline-block text-sm text-accent">Back to Multies</Link>
  </section>;
}
