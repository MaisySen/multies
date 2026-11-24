import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { IconAgent, IconCheck, IconEye, IconPencilLine, IconShieldCheck } from "@/web/components/ui/icon";
import { Button } from "@/web/components/ui/button";
import { Select } from "@/web/components/ui/input";
import { api, ApiError } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";

interface Info {
  client: { name: string; uri: string | null };
  redirectHost: string;
  requestedScope: "read" | "full";
  workspaces: { id: string; name: string; role: string; ssoRequired?: boolean }[];
  activeOrgId: string;
  user: { name: string; email: string };
}

/**
 * The OAuth consent screen for MCP clients (round 20): desktop chat apps, code editors and other AI apps send
 * people here to connect a Multies workspace. Signed out people sign in first and come back.
 */
export function OAuthAuthorizePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  // The raw link goes to the server on both the consent read and Allow, so the server reads one request the same
  // way both times (a repeated client_id or redirect_uri is refused there) and the page never picks a value itself.
  const qs = params.toString();
  const info = useQuery({ queryKey: ["oauth-authorize", qs], queryFn: () => api.get<Info>(`/oauth/authorize?${qs}`), retry: false });
  const [orgId, setOrgId] = useState("");
  const [scope, setScope] = useState<"read" | "full">("full");
  useEffect(() => {
    if (info.data) { const open = info.data.workspaces.filter((w) => !w.ssoRequired); setOrgId(info.data.activeOrgId && open.some((w) => w.id === info.data!.activeOrgId) ? info.data.activeOrgId : open[0]?.id ?? ""); setScope(info.data.requestedScope); }
  }, [info.data]);
  useEffect(() => {
    if (info.error instanceof ApiError && info.error.status === 401) navigate(`/login?next=${encodeURIComponent(`/oauth/authorize?${qs}`)}`, { replace: true });
  }, [info.error, navigate, qs]);
  const decide = useMutation({
    mutationFn: (decision: "allow" | "deny") => api.post<{ redirectTo: string }>("/oauth/authorize", { decision, orgId, scope, query: qs }),
    onSuccess: (r) => { window.location.assign(r.redirectTo); },
  });

  if (info.isPending || (info.error instanceof ApiError && info.error.status === 401)) return <Card><p className="text-sm text-muted">Loading</p></Card>;
  if (info.error) {
    return (
      <Card>
        <h1 className="text-xl font-semibold tracking-tight">This sign in link doesn't work</h1>
        <p className="mt-2 text-sm text-muted" data-testid="oauth-error">{info.error.message}</p>
      </Card>
    );
  }
  const d = info.data;
  const noWorkspace = !d.workspaces.length;
  return (
    <Card>
      <div className="flex items-center gap-3">
        <div className="grid h-11 w-11 place-items-center rounded-full bg-brand/10 text-accent" aria-hidden><IconAgent className="h-5 w-5" /></div>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight" data-testid="oauth-title">Connect {d.client.name} to Multies</h1>
          <p className="truncate text-sm text-muted">Signed in as {d.user.email}</p>
        </div>
      </div>
      <p className="mt-4 text-sm text-muted">{d.client.name} will work in your workspace as you, with your role. Agent sends still follow your approval rules and daily caps.</p>
      {noWorkspace ? <p className="mt-4 text-sm text-muted">You are not a member of any workspace yet.</p> : (
        <div className="mt-5 space-y-4">
          <label className="block text-sm font-medium">Workspace
            <Select className="mt-1.5 w-full" value={orgId} onChange={(e) => setOrgId(e.target.value)} data-testid="oauth-workspace">
              {/* PRIV1b (P41): a workspace that needs SSO for this sign in can't be picked here. */}
              {d.workspaces.map((w) => <option key={w.id} value={w.id} disabled={w.ssoRequired}>{w.ssoRequired ? `${w.name} (SSO)` : w.name}</option>)}
            </Select>
          </label>
          <fieldset>
            <legend className="text-sm font-medium">Access</legend>
            <div className="mt-1.5 grid gap-2">
              <ScopeOption active={scope === "full"} disabled={d.requestedScope === "read"} onClick={() => setScope("full")} icon={<IconPencilLine className="h-4 w-4" />} title="Read and write" detail="Read mail, tasks, docs and chat; create and update work; send mail as an agent inbox." testId="oauth-scope-full" />
              <ScopeOption active={scope === "read"} onClick={() => setScope("read")} icon={<IconEye className="h-4 w-4" />} title="Read only" detail="Read and search. Nothing is created, changed or sent." testId="oauth-scope-read" />
            </div>
          </fieldset>
        </div>
      )}
      {decide.error && <p role="alert" className="mt-4 rounded-lg border border-bad/25 bg-bad-soft px-3 py-2.5 text-sm text-bad">{decide.error.message}</p>}
      <div className="mt-6 flex gap-3">
        <Button variant="secondary" className="flex-1" disabled={decide.isPending} onClick={() => decide.mutate("deny")} data-testid="oauth-deny">Cancel</Button>
        <Button className="flex-1" disabled={noWorkspace || !orgId} loading={decide.isPending && decide.variables === "allow"} onClick={() => decide.mutate("allow")} data-testid="oauth-allow">Allow</Button>
      </div>
      <p className="mt-5 flex items-start gap-2 text-xs text-subtle"><IconShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />After you allow, you go back to {d.redirectHost}. You can disconnect {d.client.name} any time in Settings, Developers.</p>
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-line bg-surface/80 p-7 shadow-pop backdrop-blur">{children}</div>;
}

function ScopeOption(p: { active: boolean; disabled?: boolean; onClick: () => void; icon: React.ReactNode; title: string; detail: string; testId: string }) {
  return (
    <button type="button" disabled={p.disabled} onClick={p.onClick} data-testid={p.testId} aria-pressed={p.active}
      className={cn("flex items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50", p.active ? "border-brand bg-brand/5" : "border-line hover:bg-elevated")}>
      <span className={cn("mt-0.5", p.active ? "text-brand" : "text-subtle")} aria-hidden>{p.icon}</span>
      <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{p.title}</span><span className="block text-xs text-muted">{p.detail}</span></span>
      {p.active && <IconCheck className="mt-0.5 h-4 w-4 text-brand" aria-hidden />}
    </button>
  );
}
