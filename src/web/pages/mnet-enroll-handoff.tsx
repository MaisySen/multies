import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/web/components/ui/button";
import { Select } from "@/web/components/ui/input";
import { api, ApiError } from "@/web/lib/api";

interface HandoffInfo {
 email: string;
 request: { version: number; purpose: string; attemptId: string; devicePublicKey: string; credentialDigest: string; challenge: string; state: string; platform: string; redirectUri: string };
 workspaces: { id: string; name: string; networkId: string }[];
 issuer: string; registrarOrigin: string; audience: string; mappingRevision: string;
}
const endpoint = "/mnet-enrollment-v1";
export function MnetEnrollHandoffPage() {
 const [params] = useSearchParams(), qs = params.toString();
 return <HandoffConsent key={qs} qs={qs} />;
}
function HandoffConsent({ qs }: { qs: string }) {
 const navigate = useNavigate();
 const [mountId] = useState(() => crypto.randomUUID()), [workspaceId, setWorkspaceId] = useState("");
 const [finished, setFinished] = useState<{ allow: boolean; redirect: string } | null>(null);
 const info = useQuery({ queryKey: ["mnet-enrollment-v1", qs, mountId], gcTime: 0, queryFn: () => api.get<HandoffInfo>(`${endpoint}/authorize?${qs}`), retry: false });
 useEffect(() => { if (info.error instanceof ApiError && info.error.status === 401) navigate(`/login?next=${encodeURIComponent(`/mnet/enroll-v1?${qs}`)}`, { replace: true }); }, [info.error, navigate, qs]);
 const decision = useMutation({
  mutationFn: async (allow: boolean) => {
   const d = info.data!, selected = d.workspaces.find((w) => w.id === workspaceId);
   if (!selected) throw new Error("Choose a workspace first.");
   const displayed = { issuer: d.issuer, registrarOrigin: d.registrarOrigin, audience: d.audience, mappingRevision: d.mappingRevision, networkId: selected.networkId };
   const p = await api.post<{ id: string }>(`${endpoint}/authorizations`, { ...d.request, workspaceId, displayed });
   const result = await api.post<{ redirectTo: string }>(`${endpoint}/authorizations/${p.id}/decision`, { decision: allow ? "allow" : "decline" });
   // Do not trust an arbitrary response redirect, even from this API. Only the
   // exact validated literal loopback callback with owner correlation is used.
   const target = new URL(result.redirectTo), expected = new URL(d.request.redirectUri);
   const fields = [...target.searchParams.keys()];
   if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}\/mnet\/enrollment\/callback$/.test(expected.href) || +expected.port < 1024 || +expected.port > 65535 || target.origin !== expected.origin || target.pathname !== expected.pathname || target.hash || target.username || target.password || target.searchParams.get("state") !== d.request.state || target.searchParams.get("attemptId") !== d.request.attemptId || fields.length !== 3 || new Set(fields).size !== 3 || (allow ? !/^[A-Za-z0-9_-]{43}$/.test(target.searchParams.get("code") ?? "") : target.searchParams.get("error") !== "access_denied")) throw new Error("Mnet callback could not be checked. Start a new request.");
   return { allow, redirect: target.href };
  }, onSuccess: setFinished,
 });
 const card = (children: React.ReactNode) => <section className="rounded-2xl border border-line bg-surface/80 p-7 shadow-pop backdrop-blur">{children}</section>;
 if (info.isPending || info.fetchStatus !== "idle" || (info.error instanceof ApiError && info.error.status === 401)) return card(<p role="status">Checking computer joining handoff...</p>);
 if (info.error) return card(<><h1 className="text-xl font-semibold">Computer joining is unavailable</h1><p role="alert" className="mt-3 text-sm text-muted">{info.error.message}</p><p className="mt-3 text-sm">Nothing was enrolled. Start a new request in Mnet.</p></>);
 if (finished) return card(<><h1 className="text-xl font-semibold">{finished.allow ? "Approval ready for Mnet" : "Computer not approved"}</h1><p className="mt-3 text-sm">{finished.allow ? "Return once to the Mnet setup that started this request. If the return fails or expires, start a new request. This computer has not joined yet." : "This request will not join a network. You can return to Mnet or close this tab."}</p><p className="mt-3 text-sm text-muted">Local development handoff only. The registrar is not connected. No screen, keyboard or mouse access was granted.</p><Button className="mt-5 w-full" onClick={() => window.location.assign(finished.redirect)}>Return to Mnet</Button></>);
 const d = info.data, selected = d.workspaces.find((w) => w.id === workspaceId);
 return card(<>
  <h1 className="text-xl font-semibold">Approve this computer joining Mnet</h1>
  <p className="mt-2 break-all text-sm text-muted">Signed in as {d.email}</p>
  <p className="mt-4 text-sm">This allows a separate joining handoff for the selected private network. It does not allow screen, keyboard or mouse access.</p>
  <div className="mt-4 rounded-xl border border-line p-3 text-sm"><p className="font-medium">Match the full public device key in Mnet</p><code className="mt-2 block break-all font-mono text-xs" data-testid="mnet-handoff-key">{d.request.devicePublicKey}</code><p className="mt-2 text-xs text-muted">Continue only if you started this request on this {d.request.platform} computer. Key possession is checked later, not by this screen.</p></div>
  {d.workspaces.length ? <label className="mt-5 block text-sm font-medium">Workspace<Select className="mt-1.5 w-full" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} disabled={decision.isPending}><option value="">Choose a workspace</option>{d.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></label> : <p className="mt-4 text-sm">No configured workspace allows this joining request.</p>}
  {selected && <p className="mt-3 break-all text-sm">Private network: <code>{selected.networkId}</code></p>}
  <details className="mt-4 break-all text-xs text-muted"><summary>Operator setup details</summary><p className="mt-2">Issuer: {d.issuer}<br />Registrar: {d.registrarOrigin}<br />Audience: {d.audience}<br />Mapping revision: {d.mappingRevision}</p></details>
  <p className="mt-4 rounded-xl border border-line p-3 text-sm">Local development handoff. The registrar is not connected, so this computer will not join yet.</p>
  {decision.error && <p role="alert" className="mt-3 text-sm text-bad">{decision.error.message} Start a new request in Mnet.</p>}
  <div className="mt-6 flex gap-3"><Button className="flex-1" variant="secondary" disabled={!workspaceId || decision.isPending || decision.isSuccess} onClick={() => decision.mutate(false)}>Decline</Button><Button className="flex-1" disabled={!workspaceId || decision.isPending || decision.isSuccess} loading={decision.isPending} onClick={() => decision.mutate(true)}>Approve handoff</Button></div>
 </>);
}
