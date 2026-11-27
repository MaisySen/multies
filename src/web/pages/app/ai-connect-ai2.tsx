/**
 * AI2 (flag AI_CONNECT_AI2): Settings, AI. Built-in AI first (free, capped each day, no key), then your own AI
 * provider under Advanced: one tap OpenRouter sign in, or paste a key once (the provider is detected from its
 * format), pick a model from the provider's live list (no typing), and test the connection.
 * Keys go to the server once and never come back; the browser only gets model ids, names and plain results.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Badge, CopyButton, Meter, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { LoadFailure } from "@/web/components/load-error-t1g";
import { ConfirmButton } from "@/web/components/ui/confirm";
import { Field, Input, Select } from "@/web/components/ui/input";
import { IconCheck, IconExternalLink, IconEye, IconEyeOff, IconRefresh, IconSparkle } from "@/web/components/ui/icon";
import { AI2_RESULT_TEXT, cleanPastedKey, detectProvider, type Ai2Model, type Ai2ProviderCard, type Ai2ProviderId } from "@/shared/ai-connect-ai2";
import { keyProblemBadge, type AiStatus } from "./ai-section";
import { AI_OFF_MEMBER, AI_OFF_MESSAGE } from "@/shared/ask-td1";

export interface BuiltinStatus { off?: boolean; available: boolean; active: boolean; paused: boolean; percent: number; calls: number; message: string | null }
interface ModelList { provider: Ai2ProviderId; models: Ai2Model[]; recommended: string | null; live: boolean; current: string; note: string | null; problem?: "key_refused" | "no_credit" }
interface TestResult { ok: boolean; code: keyof typeof AI2_RESULT_TEXT; message: string; ms: number | null; model: string }

const cardClass = "rounded-xl border border-line bg-elevated/60 p-4";

/** The whole AI2 panel inside the AI section. */
export function AiConnectPanel({ status, isAdmin }: { status: AiStatus; isAdmin: boolean }) {
  const qc = useQueryClient();
  const [changing, setChanging] = useState(false);
  const [advanced, setAdvanced] = useState(status.connected || !status.builtin?.available);
  useReturnFromSignIn(qc);
  const merge = (s: unknown) => qc.setQueryData(["ai-status"], { ...status, ...(s as object) });
  const remove = useMutation({
    mutationFn: () => api.del("/ai/key"),
    onSuccess: (s) => { merge(s); qc.removeQueries({ queryKey: ["ai2-models"] }); void qc.invalidateQueries({ queryKey: ["ai-status"] }); toast.success("Key removed"); },
    onError: (e) => showError(e),
  });
  const showConnect = isAdmin && (!status.connected || changing);
  // TD1 switch off: nothing here may reach a provider, so the panel says so and offers no connect, list or test.
  if (status.builtin?.off) {
    return (
      <div className="space-y-4" data-testid="ai2-panel">
        <section className={cardClass} role="status" data-testid="ai2-off">
          <p className="font-medium">AI is off</p>
          <p className="mt-1 text-sm text-muted">{isAdmin ? AI_OFF_MESSAGE : AI_OFF_MEMBER} While it's off, Multies makes no AI calls, built-in or with your own key.</p>
          {status.connected && <p className="mt-2 text-sm">Saved: {status.providerName}{status.baseHost ? ` (${status.baseHost})` : ""}, key ending {status.keyHint}.</p>}
        </section>
      </div>
    );
  }
  return (
    <div className="space-y-4" data-testid="ai2-panel">
      <BuiltinCard builtin={status.builtin} ownKey={status.connected} keyProblem={!!status.problem && status.keyFallback === true} ownKeyRefused={!!status.problem} />
      <section className={cardClass} aria-labelledby="ai2-own-title">
        <button
          type="button" className="flex w-full items-center justify-between gap-3 text-left" aria-expanded={advanced}
          aria-controls="ai2-own-body" onClick={() => setAdvanced((v) => !v)} data-testid="ai2-advanced-toggle"
        >
          <span>
            <span id="ai2-own-title" className="block font-medium">Advanced: your own AI provider</span>
            <span className="block text-xs text-muted">Use your own provider account. It's used instead of built-in AI, and your provider bills you.</span>
          </span>
          <span aria-hidden className="text-muted">{advanced ? "Hide" : "Show"}</span>
        </button>
        {advanced && (
          <div id="ai2-own-body" className="mt-4 space-y-4">
            {status.connected && (
              <div className="flex flex-wrap items-center gap-3 text-sm" data-testid="ai2-connected">
                {/* QUAL1 (audit row 14): a key the provider refused is never a green "Connected". */}
                {status.problem ? <Badge tone="bad" dot>{keyProblemBadge(status.problem)}</Badge> : <Badge tone="ok" dot>Connected</Badge>}
                <span>{status.providerName}{status.baseHost ? ` (${status.baseHost})` : ""}, key ending {status.keyHint}</span>
                {isAdmin && (
                  <span className="ml-auto flex flex-wrap gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setChanging((v) => !v)} aria-expanded={changing}>{changing ? "Keep this key" : "Change provider or key"}</Button>
                    <ConfirmButton size="sm" variant="ghost" armedLabel="Tap again to remove" onConfirm={() => remove.mutate()} disabled={remove.isPending}>Remove key</ConfirmButton>
                  </span>
                )}
              </div>
            )}
            {status.connected && status.problem && (
              <div role="status" data-testid="ai2-key-problem" className="rounded-lg bg-bad-soft px-3 py-2 text-[13px] text-bad">
                <p>{status.problemMessage}{status.problemAt ? ` Since ${new Date(status.problemAt).toLocaleString()}.` : ""}</p>
                {isAdmin
                  ? <p className="mt-1 text-fg">{status.problem === "model_unavailable" ? "Pick another model below, then test the connection." : "Paste a new key with Change provider or key, or fix it with your provider and press Test connection."}</p>
                  : <p className="mt-1 text-fg">Ask an admin to fix it.</p>}
              </div>
            )}
            {status.connected && isAdmin && !changing && <ModelAndTest status={status} />}
            {status.connected && !isAdmin && <p className="text-sm text-muted">Model: {status.model}. An admin can change it.</p>}
            {showConnect && <ConnectForm cards={status.cards ?? []} onConnected={(s) => { merge(s); setChanging(false); void qc.invalidateQueries({ queryKey: ["ai-status"] }); }} />}
            {!isAdmin && !status.connected && <p className="text-sm text-muted">An admin can connect an AI provider.</p>}
          </div>
        )}
      </section>
      <OwnAiAppCard url={status.mcp.url} />
    </div>
  );
}

/** After the OpenRouter sign in the server sends the person back here with ?ai_connected or ?ai_error. */
function useReturnFromSignIn(qc: ReturnType<typeof useQueryClient>) {
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const ok = q.get("ai_connected");
    const err = q.get("ai_error");
    if (!ok && !err) return;
    if (ok) { toast.success("Connected to OpenRouter"); void qc.invalidateQueries({ queryKey: ["ai-status"] }); }
    if (err) toast.error(err.slice(0, 200));
    q.delete("ai_connected"); q.delete("ai_error");
    const rest = q.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
  }, [qc]);
}

function BuiltinCard({ builtin, ownKey, keyProblem, ownKeyRefused }: { builtin?: BuiltinStatus; ownKey: boolean; keyProblem?: boolean; ownKeyRefused?: boolean }) {
  if (!builtin) return null;
  // QUAL1: while the own key is refused, built-in AI answers in its place (the answers say so).
  const state = !builtin.available ? "off" : ownKey && keyProblem ? "standing_in" : ownKey ? "standby" : builtin.paused ? "paused" : "on";
  return (
    <section className={cardClass} aria-labelledby="ai2-builtin-title" data-testid="ai2-builtin">
      <div className="flex flex-wrap items-center gap-2">
        <IconSparkle className="h-4 w-4 text-brand-hover" aria-hidden />
        <h3 id="ai2-builtin-title" className="font-medium">Built-in AI</h3>
        {state === "on" && <Badge tone="ok" dot>On</Badge>}
        {state === "paused" && <Badge tone="warn" dot>Paused until tomorrow</Badge>}
        {state === "standby" && <Badge tone="neutral">{ownKeyRefused ? "Not in use: it does not answer in place of your key" : "Not in use: your own key is used"}</Badge>}
        {state === "standing_in" && <Badge tone="warn" dot>Answering while your key is refused</Badge>}
        {state === "off" && <Badge tone="neutral">Not available here</Badge>}
      </div>
      <p className="mt-1 text-sm text-muted">Free, with no key. Sorting, summaries and drafted replies work right away, within a fair daily limit for each workspace.</p>
      {builtin.available && !ownKey && (
        <div className="mt-3 space-y-1">
          <div className="flex items-center justify-between text-xs text-muted"><span>Today's free use in this workspace</span><span>{builtin.percent}% used, {builtin.calls} {builtin.calls === 1 ? "request" : "requests"}</span></div>
          <Meter value={builtin.percent} max={100} label={`Built-in AI today: ${builtin.percent}% used`} />
          {builtin.message && <p className="text-xs text-muted" role="status">{builtin.message}</p>}
        </div>
      )}
    </section>
  );
}

/** Paste a key once (provider detected), or one tap sign in with OpenRouter. */
function ConnectForm({ cards, onConnected }: { cards: Ai2ProviderCard[]; onConnected: (s: unknown) => void }) {
  const [apiKey, setApiKey] = useState("");
  const [show, setShow] = useState(false);
  const [picked, setPicked] = useState<Ai2ProviderId | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const detected = useMemo(() => detectProvider(apiKey), [apiKey]);
  const provider = picked ?? detected;
  const card = cards.find((c) => c.id === provider);
  const groupId = useId();
  const connect = useMutation({
    mutationFn: () => api.post<{ live: boolean }>("/ai/connect", { apiKey: cleanPastedKey(apiKey), ...(provider ? { provider } : {}), ...(provider === "custom" ? { baseUrl: baseUrl.trim() } : {}), ...(model.trim() ? { model: model.trim() } : {}) }),
    onSuccess: (s) => { setApiKey(""); setError(null); toast.success(`Connected to ${card?.name ?? "your provider"}`); onConnected(s); },
    onError: (e) => setError(e instanceof Error ? e.message : "That didn't work. Try again."),
  });
  const keyShort = cleanPastedKey(apiKey).length > 0 && cleanPastedKey(apiKey).length < 16;
  const addressBad = provider === "custom" && !/^https:\/\/\S+$/.test(baseUrl.trim());
  const ready = cleanPastedKey(apiKey).length >= 16 && !!provider && !addressBad;
  return (
    <div className="space-y-4" data-testid="ai2-connect">
      <a href="/api/ai/oauth/openrouter/start" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line-strong bg-bg/40 p-4 transition-colors duration-150 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand" data-testid="ai2-openrouter">
        <span>
          <span className="block font-medium">Connect with OpenRouter</span>
          <span className="block text-xs text-muted">Sign in and approve. No key to copy, and every major model works through it.</span>
        </span>
        <span className="inline-flex h-9 items-center rounded-lg bg-brand px-4 text-sm font-medium text-brand-fg max-sm:min-h-11">Connect</span>
      </a>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (ready) connect.mutate(); }}>
        <Field label="Or paste an API key" error={error ?? undefined} hint={detected && !picked ? <span data-testid="ai2-detected">Looks like {cards.find((c) => c.id === detected)?.name ?? detected} key.</span> : "We work out the provider from the key. Stored encrypted, never shown again."}>
          {(p) => (
            <div className="flex gap-2">
              <Input {...p} className="flex-1 font-mono" type={show ? "text" : "password"} value={apiKey} onChange={(e) => { setApiKey(e.target.value); setError(null); }}
                onPaste={(e) => { e.preventDefault(); setApiKey(cleanPastedKey(e.clipboardData.getData("text"))); setError(null); }}
                autoComplete="off" spellCheck={false} autoCapitalize="off" placeholder="Paste key" data-testid="ai2-key" />
              <Button variant="outline" size="icon" onClick={() => setShow((v) => !v)} aria-label={show ? "Hide key" : "Show key"} aria-pressed={show}>
                {show ? <IconEyeOff className="h-4 w-4" aria-hidden /> : <IconEye className="h-4 w-4" aria-hidden />}
              </Button>
            </div>
          )}
        </Field>
        <fieldset>
          <legend id={groupId} className="mb-2 text-[13px] font-medium text-fg/90">Provider</legend>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-labelledby={groupId}>
            {cards.filter((c) => !c.oneTap).map((c) => (
              <ProviderCard key={c.id} card={c} selected={provider === c.id} onSelect={() => setPicked(c.id)} />
            ))}
          </div>
        </fieldset>
        {provider === "custom" && (
          <Field label="Server address" hint="The https address that ends before /chat/completions, like https://api.example.com/v1. Public addresses only.">
            {(p) => <Input {...p} type="url" inputMode="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" autoComplete="off" spellCheck={false} data-testid="ai2-base-url" />}
          </Field>
        )}
        <Field label="Model id" hint="Only if the provider's model list cannot be read. Leave empty to use the recommended model from the list.">
          {(p) => <Input {...p} value={model} onChange={(e) => setModel(e.target.value)} placeholder="provider/model" autoComplete="off" spellCheck={false} maxLength={120} className="font-mono" data-testid="ai2-connect-model" />}
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" loading={connect.isPending} disabled={!ready} data-testid="ai2-connect-submit">Connect</Button>
          {keyShort && <span className="text-xs text-muted">The key needs at least 16 characters.</span>}
          {!provider && cleanPastedKey(apiKey).length >= 16 && <span className="text-xs text-muted">Pick your provider above.</span>}
          {addressBad && baseUrl.trim().length > 0 && <span className="text-xs text-muted">The server address must start with https://.</span>}
        </div>
      </form>
    </div>
  );
}

function ProviderCard({ card, selected, onSelect }: { card: Ai2ProviderCard; selected: boolean; onSelect: () => void }) {
  return (
    <div className={`flex flex-col gap-2 rounded-lg border p-3 transition-colors duration-150 ${selected ? "border-brand bg-brand/5" : "border-line hover:bg-hover"}`}>
      <button type="button" role="radio" aria-checked={selected} onClick={onSelect} className="flex items-start gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded-md max-sm:min-h-11" data-testid={`ai2-card-${card.id}`}>
        <span aria-hidden className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border ${selected ? "border-brand bg-brand text-brand-fg" : "border-line-strong"}`}>{selected && <IconCheck className="h-3 w-3" />}</span>
        <span>
          <span className="block text-sm font-medium">{card.name}</span>
          <span className="block text-xs text-muted">{card.blurb}</span>
        </span>
      </button>
      {card.keysUrl && (
        <a className="inline-flex items-center gap-1 self-start text-xs text-muted underline underline-offset-2 hover:text-fg max-sm:min-h-11 max-sm:items-center" href={card.keysUrl} target="_blank" rel="noopener noreferrer">
          Get a key<span className="sr-only"> from {card.name} (opens in a new tab)</span><IconExternalLink className="h-3 w-3" aria-hidden />
        </a>
      )}
    </div>
  );
}

/** Model picker (live list, searchable, recommended first) and the connection test. */
function ModelAndTest({ status }: { status: AiStatus }) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState("");
  const [typed, setTyped] = useState("");
  const [result, setResult] = useState<TestResult | null>(null);
  const key = ["ai2-models", status.provider, status.keyHint, status.baseHost ?? ""];
  const list = useQuery({ queryKey: key, queryFn: () => api.post<ModelList>("/ai/models", {}), staleTime: 5 * 60_000, retry: false });
  const refresh = useMutation({ mutationFn: () => api.post<ModelList>("/ai/models", { refresh: true }), onSuccess: (d) => qc.setQueryData(key, d), onError: (e) => showError(e) });
  const save = useMutation({
    mutationFn: (model: string) => api.put<{ model: string }>("/ai/model", { model }),
    onSuccess: (r) => { qc.setQueryData(["ai-status"], { ...status, model: r.model }); qc.setQueryData(key, (d: ModelList | undefined) => (d ? { ...d, current: r.model } : d)); setResult(null); setTyped(""); toast.success("Model saved"); },
    onError: (e) => showError(e),
  });
  // QUAL1: a test can clear or set the key's refusal, so the status (badge, Team AI, the assistant) is read again.
  const test = useMutation({ mutationFn: () => api.post<TestResult>("/ai/test", {}), onSuccess: (r) => { setResult(r); void qc.invalidateQueries({ queryKey: ["ai-status"] }); if (r.ok && list.data?.problem) void list.refetch(); }, onError: (e) => showError(e) });
  // QUAL1: the list found the key refused before anything else did: show it on the badge too.
  useEffect(() => { if (list.data?.problem && !status.problem) void qc.invalidateQueries({ queryKey: ["ai-status"] }); }, [list.data?.problem, status.problem, qc]);
  const current = list.data?.current ?? status.model ?? "";
  const shown = useMemo(() => {
    const all = list.data?.models ?? [];
    const f = filter.trim().toLowerCase();
    return f ? all.filter((m) => m.id.toLowerCase().includes(f) || m.name.toLowerCase().includes(f)) : all;
  }, [list.data, filter]);
  const rec = list.data?.recommended ? (list.data.models.find((m) => m.id === list.data!.recommended) ?? null) : null;
  // The saved model always has an option, even when the search hides it or the provider no longer lists it.
  const currentShown = shown.some((m) => m.id === current) || (!!rec && !filter && rec.id === current);
  return (
    <div className="space-y-4" data-testid="ai2-model">
      {list.isLoading ? (
        <div role="status" className="space-y-2" aria-busy="true" aria-label="Loading models"><Skeleton className="h-4 w-24" /><Skeleton className="h-9 w-full" /></div>
      ) : list.isError ? (
        <LoadFailure error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <Field label="Find a model">{(p) => <Input {...p} type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search" autoComplete="off" data-testid="ai2-model-search" />}</Field>
          <Field label="Model" hint={list.data?.live === false ? undefined : `${list.data?.models.length ?? 0} models from ${status.providerName}.`}>
            {(p) => (
              <div className="flex min-w-0 items-start gap-2">
                <div className="min-w-0 flex-1 overflow-hidden">
                <Select {...p} className="w-full min-w-0 truncate" value={current} onChange={(e) => e.target.value && e.target.value !== current && save.mutate(e.target.value)} disabled={save.isPending} data-testid="ai2-model-select">
                  {!currentShown && current && <option value={current}>{current} (saved)</option>}
                  {rec && !filter && (
                    <optgroup label="Recommended">
                      <option value={rec.id}>{rec.name}, recommended for inbox</option>
                    </optgroup>
                  )}
                  <optgroup label={filter ? `Matches (${shown.length})` : "All models"}>
                    {shown.filter((m) => filter || m.id !== rec?.id).map((m) => <option key={m.id} value={m.id}>{m.name === m.id ? m.id : `${m.name} (${m.id})`}</option>)}
                  </optgroup>
                </Select>
                </div>
                <Button variant="outline" size="icon" className="shrink-0" onClick={() => refresh.mutate()} loading={refresh.isPending} aria-label="Reload the model list"><IconRefresh className="h-4 w-4" aria-hidden /></Button>
              </div>
            )}
          </Field>
        </div>
      )}
      {list.data && !list.data.live && (
        <p className={list.data.problem ? "text-xs text-bad" : "text-xs text-muted"} role="status" data-testid="ai2-fallback">{list.data.note}</p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="secondary" onClick={() => { setResult(null); test.mutate(); }} loading={test.isPending} data-testid="ai2-test">Test connection</Button>
        <p aria-live="polite" className="text-sm" data-testid="ai2-test-result">
          {result && <span className={result.ok ? "text-ok" : "text-bad"}>{result.message}</span>}
        </p>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted hover:text-fg max-sm:min-h-11 max-sm:py-2">Advanced: type a model id</summary>
        <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) save.mutate(typed.trim()); }}>
          <Field label="Model id" className="min-w-0 flex-1" hint="Only if your model is not in the list.">
            {(p) => <Input {...p} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={current} autoComplete="off" spellCheck={false} maxLength={120} className="font-mono" data-testid="ai2-model-typed" />}
          </Field>
          <Button type="submit" size="sm" variant="outline" disabled={!typed.trim()} loading={save.isPending}>Save model</Button>
        </form>
      </details>
    </div>
  );
}

/** "Use your own AI app": the MCP connection in three steps with copy buttons. */
function OwnAiAppCard({ url }: { url: string }) {
  const snippet = JSON.stringify({ mcpServers: { multies: { url } } }, null, 2);
  return (
    <section className={cardClass} aria-labelledby="ai2-app-title" data-testid="ai2-app">
      <h3 id="ai2-app-title" className="font-medium">Use your own AI app</h3>
      <p className="mt-1 text-sm text-muted">Connect a desktop chat app, a code editor or any MCP client to this workspace, free.</p>
      <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm">
        <li>In your AI app's settings, add a custom connector (it may be called an MCP server).</li>
        <li>Paste the server address, or the config below if the app asks for a file.</li>
        <li>Sign in to Multies when asked and pick this workspace.</li>
      </ol>
      <div className="mt-3 space-y-3">
        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-subtle"><span>Server address</span><CopyButton value={url} label="Copy address" toastText="Address copied" /></div>
          <code className="block overflow-x-auto rounded-lg border border-line bg-bg/60 p-2 font-mono text-[12px]">{url}</code>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-subtle"><span>Config file</span><CopyButton value={snippet} label="Copy config" toastText="Config copied" /></div>
          <pre tabIndex={0} className="max-h-40 overflow-auto rounded-lg border border-line bg-bg/60 p-2 font-mono text-[12px]">{snippet}</pre>
        </div>
        <Link className="inline-flex items-center gap-1 text-sm underline underline-offset-2 hover:text-fg" to="/agents#mcp">Full setup guide</Link>
      </div>
    </section>
  );
}
