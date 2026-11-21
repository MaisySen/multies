import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/web/components/ui/button";
import { Select } from "@/web/components/ui/input";
import { api, ApiError } from "@/web/lib/api";

interface EnrollmentInfo {
 email: string;
 request: { attemptId: string; devicePublicKey: string; platform: string };
 workspaces: { id: string; name: string; networkId: string }[];
 registrarOrigin: string; issuer: string; audience: string; mappingRevision: string;
}
/** Separate enrollment-only consent. No token exchange or registrar is connected. */
export function MnetEnrollPage() {
 const [params] = useSearchParams(), navigate = useNavigate();
 const qs = params.toString(), [workspaceId, setWorkspaceId] = useState("");
 const [readId] = useState(() => crypto.randomUUID());
 const [finished, setFinished] = useState<"approved" | "declined" | null>(null);
 const info = useQuery({ queryKey: ["mnet-enroll", qs, readId], gcTime: 0, queryFn: () => api.get<EnrollmentInfo>(`/mnet-enrollment/authorize?${qs}`), retry: false });
 useEffect(() => { if (info.error instanceof ApiError && info.error.status === 401) navigate(`/login?next=${encodeURIComponent(`/mnet/enroll?${qs}`)}`, { replace: true }); }, [info.error, navigate, qs]);
 const decision = useMutation({
  mutationFn: async (allow: boolean) => {
   const d = info.data!, selected = d.workspaces.find((w) => w.id === workspaceId);
   if (!selected) throw new Error("Choose a current workspace before approving.");
   const displayed = { issuer: d.issuer, registrarOrigin: d.registrarOrigin, audience: d.audience, mappingRevision: d.mappingRevision, networkId: selected.networkId };
   const prepared = await api.post<{ id: string }>("/mnet-enrollment/decisions", { ...d.request, workspaceId, displayed });
   await api.post(`/mnet-enrollment/decisions/${prepared.id}`, { decision: allow ? "allow" : "decline" });
   return allow;
  },
  onSuccess: (allow) => setFinished(allow ? "approved" : "declined"),
 });
 const card = (children: React.ReactNode) => <section className="rounded-2xl border border-line bg-surface/80 p-7 shadow-pop backdrop-blur">{children}</section>;
 if (info.isPending || info.fetchStatus !== "idle" || (info.error instanceof ApiError && info.error.status === 401)) return card(<p role="status">Checking computer joining request...</p>);
 if (info.error) return card(<><h1 className="text-xl font-semibold">Computer joining is unavailable</h1><p role="alert" className="mt-3 text-sm text-muted">{info.error.message}</p><p className="mt-3 text-sm">Nothing was approved. Return to Mnet to start again.</p></>);
 if (finished) return card(<><h1 className="text-xl font-semibold">{finished === "approved" ? "Joining approval recorded" : "Computer not approved"}</h1><p className="mt-3 text-sm">{finished === "approved" ? "This separate joining decision was recorded. The registrar is not connected, so this computer has not joined a network." : "This request cannot join a network. You can close this tab."}</p><p className="mt-3 text-sm text-muted">No screen, keyboard or mouse access was granted.</p></>);
 const d = info.data, selected = d.workspaces.find((w) => w.id === workspaceId);
 return card(<>
  <h1 className="text-xl font-semibold tracking-tight">Approve this computer joining Mnet</h1>
  <p className="mt-2 break-all text-sm text-muted">Signed in as {d.email}</p>
  <p className="mt-4 text-sm">This is a separate network joining decision, not device-list sign in. Screen, keyboard and mouse access need separate approval.</p>
  <div className="mt-4 rounded-xl border border-line p-3 text-sm"><p className="font-medium">Match the full public device key in Mnet</p><code className="mt-2 block break-all font-mono text-xs" data-testid="mnet-enroll-key">{d.request.devicePublicKey}</code><p className="mt-2 text-xs text-muted">Only continue if you started this request yourself on this {d.request.platform} computer. A matching displayed key is not yet proof of possession.</p></div>
  {d.workspaces.length ? <label className="mt-5 block text-sm font-medium">Workspace<Select className="mt-1.5 w-full" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} disabled={decision.isPending}><option value="">Choose a workspace</option>{d.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></label> : <p className="mt-4 text-sm">No configured workspace allows you to enroll this computer. Nothing was created.</p>}
  {selected && <p className="mt-3 break-all text-sm">Private network: <code>{selected.networkId}</code></p>}
  <details className="mt-4 text-xs text-muted"><summary>Operator setup details</summary><dl className="mt-2 space-y-1 break-all"><dt>Registrar</dt><dd>{d.registrarOrigin}</dd><dt>Issuer</dt><dd>{d.issuer}</dd><dt>Audience</dt><dd>{d.audience}</dd><dt>Mapping revision</dt><dd>{d.mappingRevision}</dd></dl></details>
  <p className="mt-4 rounded-xl border border-line p-3 text-sm">Local branch preview: joining approval can be recorded, but the registrar is not connected. This computer will not join yet.</p>
  {decision.error && <p role="alert" className="mt-3 text-sm text-bad">{decision.error.message} Start a new request in Mnet. Do not assume it joined.</p>}
  <div className="mt-6 flex gap-3"><Button variant="secondary" className="flex-1" disabled={decision.isPending || decision.isSuccess} onClick={() => { if (workspaceId) decision.mutate(false); else setFinished("declined"); }}>Decline</Button><Button className="flex-1" disabled={!workspaceId || decision.isPending || decision.isSuccess} loading={decision.isPending} onClick={() => decision.mutate(true)}>Approve joining</Button></div>
 </>);
}
