import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { useMe } from "@/web/lib/queries";
import { Badge } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Field, Input, Select } from "@/web/components/ui/input";
import { Section } from "./settings";

export type AiProviderId = "openai" | "anthropic" | "openrouter" | "groq";
export interface AiStatus {
  connected: boolean; provider: AiProviderId | null; providerName: string | null; model: string | null; keyHint: string | null;
  providers: { id: AiProviderId; name: string; defaultModel: string; keysUrl: string }[];
  mcp: { url: string; docs: string };
  message: string;
}

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
  const [provider, setProvider] = useState<AiProviderId>("openai");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const refresh = (s: unknown) => qc.setQueryData(["ai-status"], { ...status.data, ...(s as object) });
  const save = useMutation({
    mutationFn: () => api.put("/ai/key", { provider, apiKey, model: model.trim() || undefined }),
    onSuccess: (s) => { refresh(s); setApiKey(""); setModel(""); toast.success("AI key saved"); },
    onError: (e) => showError(e),
  });
  const remove = useMutation({ mutationFn: () => api.del("/ai/key"), onSuccess: (s) => { refresh(s); toast.success("AI key removed"); }, onError: (e) => showError(e) });
  const isAdmin = me.data?.organization?.role !== "member";
  const d = status.data;
  const info = d?.providers.find((p) => p.id === provider);
  return (
    <Section id="ai" title="AI" description={<>{BYO_AI_LINE} Multies never charges for AI. <Link className="underline underline-offset-2 hover:text-fg" to="/agents#mcp">MCP setup</Link></>}>
      <div className="space-y-4 text-sm">
        <p className="text-muted">The assistant in the inbox (summaries, drafted replies, sorting) runs on your own key. Your provider bills you directly.</p>
        {d?.connected ? (
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone="ok" dot>Connected</Badge>
            <span>{d.providerName}, {d.model}, key ending {d.keyHint}</span>
            {isAdmin && <Button size="sm" variant="ghost" loading={remove.isPending} onClick={() => remove.mutate()}>Remove key</Button>}
          </div>
        ) : <p className="text-muted">No key added, so the assistant is off.</p>}
        {isAdmin ? (
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <Field label="Provider">{(p) => (
              <Select {...p} value={provider} onChange={(e) => setProvider(e.target.value as AiProviderId)}>
                {(d?.providers ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </Select>
            )}</Field>
            <Field label="Model" hint={info ? `Leave empty for ${info.defaultModel}` : undefined}>{(p) => <Input {...p} value={model} onChange={(e) => setModel(e.target.value)} placeholder={info?.defaultModel} autoComplete="off" />}</Field>
            <Field label="API key" className="sm:col-span-2" hint={info ? <>Create one at <a className="underline underline-offset-2" href={info.keysUrl} target="_blank" rel="noreferrer">{info.name}</a>. Stored encrypted.</> : undefined}>
              {(p) => <Input {...p} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" spellCheck={false} />}
            </Field>
            <div className="sm:col-span-2"><Button type="submit" size="sm" loading={save.isPending} disabled={apiKey.trim().length < 16}>{d?.connected ? "Replace key" : "Save key"}</Button></div>
          </form>
        ) : <p className="text-muted">An admin can add an AI key.</p>}
      </div>
    </Section>
  );
}
