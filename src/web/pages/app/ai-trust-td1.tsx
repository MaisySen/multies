/**
 * TD1 AI trust controls (Settings > AI, flag ASK_TD1): AI is off until an admin turns it on. Everyone sees whether AI is
 * on, which provider runs each feature and where it runs. Only admins see the switch. Its own file so the AI key screen
 * (rebuilt separately) is untouched.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { useConfig } from "@/web/lib/queries";
import { Badge, Skeleton, Switch } from "@/web/components/ui/misc";
import { LoadFailure } from "@/web/components/load-error-t1g";
import { Section } from "./settings";

export interface AiTrust {
  controls: boolean; on: boolean; source: "admin" | "own_key" | "default"; canChange: boolean; updatedAt: string | null;
  providers: { use: string; name: string; region: string }[];
}

export const TRUST_OFF_LINE = "AI is off. Nothing is sent to any AI provider, and AI buttons say so.";
export const TRUST_ON_LINE = "AI is on for everyone in this workspace. Items are sent to the provider below only when someone uses an AI feature, and only items that person can open.";

export function AiTrustSection() {
  const config = useConfig();
  const on = !!config.data?.askTd1;
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["ai-trust"], enabled: on, queryFn: () => api.get<AiTrust>("/ai-trust") });
  const set = useMutation({
    mutationFn: (enabled: boolean) => api.put<AiTrust>("/ai-trust", { enabled }),
    onSuccess: (r) => {
      qc.setQueryData(["ai-trust"], r);
      void qc.invalidateQueries({ queryKey: ["ask-state"] });
      toast.success(r.on ? "AI turned on" : "AI turned off");
    },
    onError: (e) => showError(e as Error),
  });
  if (!on) return null;
  return (
    <Section id="ai-trust" title="AI on or off" description="Decide if AI can be used in this workspace, and see exactly where your data goes when it is.">
      <div data-testid="ai-trust" className="space-y-4 text-[14px]">
        {q.isPending ? <div className="space-y-2"><Skeleton className="h-6 w-1/2" /><Skeleton className="h-16" /></div>
          : q.isError ? <LoadFailure block error={q.error} onRetry={() => q.refetch()} />
          : (
            <>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 font-medium" data-testid="ai-trust-status">
                    {q.data.on ? <Badge tone="ok" dot>AI is on</Badge> : <Badge dot>AI is off</Badge>}
                  </p>
                  <p className="mt-1 text-muted">{q.data.on ? TRUST_ON_LINE : TRUST_OFF_LINE}</p>
                  {!q.data.canChange && <p className="mt-1 text-xs text-subtle" data-testid="ai-trust-member">Only an admin can change this.</p>}
                  {q.data.source === "own_key" && <p className="mt-1 text-xs text-subtle">On because an admin added the workspace's own AI key.</p>}
                </div>
                {q.data.canChange && (
                  <div className="flex min-h-11 items-center" data-testid="ai-trust-switch">
                    <Switch checked={q.data.on} onChange={(v) => set.mutate(v)} label="Allow AI in this workspace" disabled={set.isPending} />
                  </div>
                )}
              </div>
              <div>
                <h3 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Where AI runs</h3>
                <ul className="mt-1.5 divide-y divide-line rounded-lg border border-line" data-testid="ai-trust-providers">
                  {q.data.providers.map((p) => (
                    <li key={p.use} className="px-3 py-2.5">
                      <p className="font-medium text-fg">{p.use}: {p.name}</p>
                      <p className="text-[13px] text-muted">{p.region}</p>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
      </div>
    </Section>
  );
}
