import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { useMe } from "@/web/lib/queries";
import { Badge, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Field, Input, Select } from "@/web/components/ui/input";
import { Section } from "./settings";
import { AiUsageLine, useAiUsage } from "./tools-ai"; // Tools P2: today's AI use for document helpers
import { useConfig } from "@/web/lib/queries";
import type { Ai2ProviderCard } from "@/shared/ai-connect-ai2";
import { AiConnectPanel, type BuiltinStatus } from "./ai-connect-ai2"; // AI2
import { tr } from "@/web/i18n"; // R104B
import "@/web/i18n/w2/en-home"; // R104B

export type AiProviderId = "openai" | "anthropic" | "openrouter" | "groq" | "gemini" | "mistral" | "deepseek" | "custom";
export interface AiStatus {
  connected: boolean; provider: AiProviderId | null; providerName: string | null; model: string | null; keyHint: string | null;
  providers: { id: AiProviderId; name: string; defaultModel: string; keysUrl: string }[];
  /** AI2 (AI_CONNECT_AI2): set only while the flag is on. */
  ai2?: boolean; cards?: Ai2ProviderCard[]; builtin?: BuiltinStatus; baseHost?: string | null;
  /** QUAL1 (audit rows 12, 14): present only while the provider refuses the saved key, its credit or its model. */
  problem?: "key_refused" | "no_credit" | "model_unavailable"; problemAt?: string; problemMessage?: string;
  /** QUAL1: AI2 only: whether built-in AI stands in for a refused key here (AI_KEY_FALLBACK). */
  keyFallback?: boolean;
  mcp: { url: string; docs: string };
  message: string;
}

/** QUAL1: the badge for a saved key the provider refused (never the green "Connected"). */
export const keyProblemBadge = (p: NonNullable<AiStatus["problem"]>) =>
  ({ key_refused: tr("ai.badge_key_refused"), no_credit: tr("ai.badge_no_credit"), model_unavailable: tr("ai.badge_model_unavailable") })[p];

export const BYO_AI_LINE = "Bring your own AI: connect a desktop chat app, a code editor or any MCP client, free.";

export const useAiStatus = () => useQuery({ queryKey: ["ai-status"], queryFn: () => api.get<AiStatus>("/ai/status"), staleTime: 60_000 });

/**
 * Bring your own AI. Multies never pays for model calls: the assistant runs on the
 * workspace's own key, which is encrypted at rest and never shown again.
 */
export function AiSection() {
  const me = useMe();
  const qc = useQueryClient();
  const status = useAiStatus();
  const config = useConfig();
  // R66 (MB-259): only asked while an AI document feature is on here (the route answers 404 otherwise).
  const toolsAi = useAiUsage(!!config.data?.tools && ["ask", "translate", "extract", "expenses", "contracts"].some((f) => (config.data?.toolFeatures as readonly string[] | undefined)?.includes(f)));
  const [provider, setProvider] = useState<AiProviderId>("openai");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const refresh = (s: unknown) => qc.setQueryData(["ai-status"], { ...status.data, ...(s as object) });
  const save = useMutation({
    mutationFn: () => api.put("/ai/key", { provider, apiKey, model: model.trim() || undefined }),
    onSuccess: (s) => { refresh(s); setApiKey(""); setModel(""); toast.success(tr("home.ai_key_saved")); },
    onError: (e) => showError(e),
  });
  const remove = useMutation({ mutationFn: () => api.del("/ai/key"), onSuccess: (s) => { refresh(s); toast.success(tr("home.ai_key_removed")); }, onError: (e) => showError(e) });
  const isAdmin = me.data?.organization?.role !== "member";
  const d = status.data;
  const info = d?.providers.find((p) => p.id === provider);
  // AI2: the new screen while AI_CONNECT_AI2 is on; off keeps the form below exactly as it was.
  if (config.data?.aiConnectAi2 && d?.ai2) {
    return (
      <Section id="ai" title="AI" description={<>{tr("home.multies_never_charges_for_ai_built_in_ai_works_w")}</>}>
        <div className="space-y-4 text-sm">
          <AiConnectPanel status={d} isAdmin={isAdmin} />
          {toolsAi.data && (
            <div className="space-y-1 border-t border-line pt-4">
              <p className="font-medium">{tr("home.ai_document_helpers_today")}</p>
              <AiUsageLine usage={toolsAi.data} />
            </div>
          )}
        </div>
      </Section>
    );
  }
  if (config.data?.aiConnectAi2 && status.isLoading) {
    return <Section id="ai" title="AI" description={tr("home.loading")}><div className="space-y-2" aria-busy="true"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div></Section>;
  }
  return (
    <Section id="ai" title="AI" description={<>{BYO_AI_LINE} {tr("home.multies_never_charges_for_ai")} <Link className="underline underline-offset-2 hover:text-fg" to="/agents#mcp">{tr("home.mcp_setup")}</Link></>}>
      <div className="space-y-4 text-sm">
        <p className="text-muted">{tr("home.the_assistant_in_the_inbox_summaries_drafted_rep")}</p>
        {d?.connected ? (
          <div className="flex flex-wrap items-center gap-3">
            {d.problem ? <Badge tone="bad" dot>{keyProblemBadge(d.problem)}</Badge> : <Badge tone="ok" dot>{tr("home.connected")}</Badge>}
            <span>{d.providerName}, {d.model}{tr("home.key_ending")} {d.keyHint}</span>
            {d.problemMessage && <span className="basis-full text-bad" role="status" data-testid="ai-key-problem">{d.problemMessage}</span>}
            {isAdmin && <Button size="sm" variant="ghost" loading={remove.isPending} onClick={() => remove.mutate()}>{tr("home.remove_key")}</Button>}
          </div>
        ) : <p className="text-muted">{tr("home.no_key_added_so_the_assistant_is_off")}</p>}
        {isAdmin ? (
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <Field label={tr("home.provider")}>{(p) => (
              <Select {...p} value={provider} onChange={(e) => setProvider(e.target.value as AiProviderId)}>
                {(d?.providers ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </Select>
            )}</Field>
            <Field label={tr("home.model")} hint={info ? `Leave empty for ${info.defaultModel}` : undefined}>{(p) => <Input {...p} value={model} onChange={(e) => setModel(e.target.value)} placeholder={info?.defaultModel} autoComplete="off" />}</Field>
            <Field label={tr("home.api_key")} className="sm:col-span-2" hint={info ? <>{tr("home.create_one_at")} <a className="underline underline-offset-2" href={info.keysUrl} target="_blank" rel="noreferrer">{info.name}</a>{tr("home.stored_encrypted")}</> : undefined}>
              {(p) => <Input {...p} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" spellCheck={false} />}
            </Field>
            <div className="sm:col-span-2"><Button type="submit" size="sm" loading={save.isPending} disabled={apiKey.trim().length < 16}>{d?.connected ? tr("home.replace_key") : tr("home.save_key")}</Button></div>
          </form>
        ) : <p className="text-muted">{tr("home.an_admin_can_add_an_ai_key")}</p>}
        {toolsAi.data && (
          <div className="space-y-1 border-t border-line pt-4">
            <p className="font-medium">{tr("home.ai_document_helpers_today")}</p>
            <AiUsageLine usage={toolsAi.data} />
            {!toolsAi.data.ownKey && <p className="text-xs text-muted">{tr("home.each_workspace_gets_a_free_daily_allowance_for_s")}</p>}
          </div>
        )}
      </div>
    </Section>
  );
}
