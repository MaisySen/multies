/**
 * C1 (chat channels, phase 1): Settings, Channels. The workspace switch, the WhatsApp connect tile (Meta Embedded
 * Signup: the Facebook SDK loads only when someone taps Connect), the test channel on local builds, the connected
 * channels with Disconnect, and today's inbound usage. With no Meta app on the server it is one calm "Coming soon" card.
 * Server: /api/channels/* (contract in src/shared/channels.ts).
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { IconCheckCircle, IconClock, IconLock, IconPlug, IconWarning } from "@/web/components/ui/icon";
import { api, errorMessage } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { num, timeAgo } from "@/web/lib/format";
import { Badge, Card, Skeleton, Switch } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { ConfirmDialog } from "@/web/components/ui/confirm";
import { PROVIDER_LABEL, type ChannelSummary, type ChannelsStatus } from "@/shared/channels";
import { ProviderTile, channelsStatusKey, useChannelsStatus } from "./channels-ui";
import { connectErrorCopy, parseSignupMessage } from "@/web/lib/chat-channels";

/* ---------- Meta Embedded Signup (v4) ---------- */

interface FbLoginResponse { authResponse?: { code?: string } | null; status?: string }
interface FbSdk {
  init(o: { appId: string; autoLogAppEvents?: boolean; xfbml?: boolean; version: string }): void;
  login(cb: (r: FbLoginResponse) => void, o: Record<string, unknown>): void;
}
declare global { interface Window { FB?: FbSdk; fbAsyncInit?: () => void } }

const SDK_URL = "https://connect.facebook.net/en_US/sdk.js";
let sdkPromise: Promise<FbSdk> | null = null;

/** Loads the Facebook JS SDK once, on demand (never on page load). */
export function loadFacebookSdk(appId: string, version: string, timeoutMs = 15_000): Promise<FbSdk> {
  if (window.FB) { window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version }); return Promise.resolve(window.FB); }
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<FbSdk>((resolve, reject) => {
    const timer = window.setTimeout(() => { sdkPromise = null; reject(new Error("sdk_timeout")); }, timeoutMs);
    window.fbAsyncInit = () => {
      window.clearTimeout(timer);
      window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve(window.FB!);
    };
    const s = document.createElement("script");
    s.src = SDK_URL; s.async = true; s.defer = true; s.crossOrigin = "anonymous";
    s.onerror = () => { window.clearTimeout(timer); sdkPromise = null; s.remove(); reject(new Error("sdk_failed")); };
    document.body.appendChild(s);
  });
  return sdkPromise;
}

function useEmbeddedSignup(status: ChannelsStatus | undefined, onConnected: (c: ChannelSummary) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ code?: string; ids?: { phoneNumberId: string; wabaId: string }; done?: boolean } | null>(null);

  const finish = async () => {
    const p = pending.current;
    if (!p || p.done || !p.code || !p.ids) return;
    p.done = true;
    try {
      const r = await api.post<{ channel: ChannelSummary }>("/channels/connect", { provider: "whatsapp", code: p.code, wabaId: p.ids.wabaId, phoneNumberId: p.ids.phoneNumberId });
      onConnected(r.channel);
    } catch (e) { setError(errorMessage(e, connectErrorCopy("server"))); }
    finally { setBusy(false); pending.current = null; }
  };

  useEffect(() => {
    const on = (e: MessageEvent) => {
      const ev = parseSignupMessage(e.origin, e.data);
      if (!ev || !pending.current) return;
      if (ev.kind === "finish") { pending.current.ids = { phoneNumberId: ev.phoneNumberId, wabaId: ev.wabaId }; void finish(); }
      else if (ev.kind === "cancel") { setError(connectErrorCopy("cancelled")); setBusy(false); pending.current = null; }
      else { setError(ev.message ? connectErrorCopy("meta_error", ev.message) : connectErrorCopy("no_number")); setBusy(false); pending.current = null; }
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  });

  const start = async () => {
    const es = status?.embeddedSignup;
    if (!es) return;
    setError(null); setBusy(true);
    pending.current = {};
    let FB: FbSdk;
    try { FB = await loadFacebookSdk(es.appId, es.graphVersion); }
    catch (e) { setError(connectErrorCopy((e as Error).message)); setBusy(false); pending.current = null; return; }
    // Embedded Signup v4: FB.login with the configuration id and a code (not a token) back. The products come from the
    // Facebook Login for Business configuration, so extras is { setup: {} } as in Meta's v4 sample. The code lives
    // about 30 s, so it goes to the server the moment the window message with the number has also arrived.
    FB.login((r) => {
      const code = r.authResponse?.code;
      if (!pending.current) return;
      if (!code) { setError(connectErrorCopy(r.status === "unknown" || !r.authResponse ? "cancelled" : "no_code")); setBusy(false); pending.current = null; return; }
      pending.current.code = code;
      if (pending.current.ids) void finish();
      // The window message usually lands first; give it a moment, then say plainly what is missing.
      else window.setTimeout(() => { if (pending.current && !pending.current.ids && !pending.current.done) { setError(connectErrorCopy("no_number")); setBusy(false); pending.current = null; } }, 8_000);
    }, { config_id: es.configId, response_type: "code", override_default_response_type: true, extras: { setup: {} } });
  };
  return { start, busy, error, clearError: () => setError(null) };
}

/* ---------- The page ---------- */

export function ChannelsSettings() {
  const qc = useQueryClient();
  const status = useChannelsStatus();
  const s = status.data;
  const setStatus = (next: ChannelsStatus) => qc.setQueryData(channelsStatusKey, next);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["channels"] }); };
  const connected = (c: ChannelSummary) => { toast.success(`${PROVIDER_LABEL[c.provider]} connected: ${c.name}`); refresh(); };
  const signup = useEmbeddedSignup(s, connected);

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.put<ChannelsStatus>("/channels/settings", { enabled }),
    onSuccess: (next) => { setStatus(next); refresh(); toast.success(next.enabled ? "Chat channels are on" : "Chat channels are off"); },
    onError: (e) => toast.error(errorMessage(e, "Couldn't change the switch. Try again.")),
  });
  const mock = useMutation({
    mutationFn: () => api.post<{ channel: ChannelSummary }>("/channels/connect-mock", { name: "Test channel" }),
    onSuccess: (r) => connected(r.channel),
    onError: (e) => toast.error(errorMessage(e, "Couldn't connect the test channel. Try again.")),
  });

  if (status.isPending) return <div className="space-y-4" data-testid="channels-settings"><Skeleton className="h-28 rounded-xl" /><Skeleton className="h-40 rounded-xl" /></div>;
  if (status.error || !s) return <Card className="p-6 text-sm text-bad" data-testid="channels-settings">{errorMessage(status.error, "Couldn't load chat channels. Try again.")}</Card>;

  if (!s.available) {
    return (
      <div data-testid="channels-settings">
        <Card className="overflow-hidden" data-testid="channels-coming-soon">
          <div className="flex flex-col items-center px-6 py-12 text-center">
            <div className="mb-4 flex -space-x-2" aria-hidden>
              <span className="rounded-[11px] ring-2 ring-surface"><ProviderTile provider="whatsapp" size="lg" /></span>
              <span className="rounded-[11px] ring-2 ring-surface"><ProviderTile provider="messenger" size="lg" /></span>
              <span className="rounded-[11px] ring-2 ring-surface"><ProviderTile provider="instagram" size="lg" /></span>
            </div>
            <Badge tone="brand"><IconClock className="h-3 w-3" aria-hidden />Coming soon</Badge>
            <h2 className="mt-3 text-[17px] font-semibold tracking-tight">Chat channels</h2>
            <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted">WhatsApp, Messenger and Instagram messages will land in your shared inbox. We are finishing setup with Meta.</p>
          </div>
        </Card>
      </div>
    );
  }

  const active = s.channels.filter((c) => c.status !== "disconnected");
  const past = s.channels.filter((c) => c.status === "disconnected");
  const hasWhatsapp = active.some((c) => c.provider === "whatsapp");
  return (
    <div className="space-y-5" data-testid="channels-settings">
      <Card>
        <div className="flex items-start gap-4 p-5 md:p-6">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold" id="channels-switch-label">Chat in the shared inbox</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted">Customer chats show next to mail. Your team can assign them, leave notes and make tasks, the same way as email.</p>
            {!s.canManage && <p className="mt-2 inline-flex items-center gap-1.5 text-[13px] text-subtle"><IconLock className="h-3.5 w-3.5" aria-hidden />Only owners and admins can change this.</p>}
          </div>
          <div className="pt-0.5" data-testid="channels-switch">
            <Switch checked={s.enabled} onChange={(v) => toggle.mutate(v)} label="Chat channels in the shared inbox" disabled={!s.canManage || toggle.isPending} />
          </div>
        </div>
        {s.canManage && s.enabled && (
          <div className={cn("flex items-center gap-2 border-t border-line px-5 py-3 text-[13px] md:px-6", s.usage.level === "over" ? "text-bad" : s.usage.level === "near" ? "text-warn" : "text-muted")} data-testid="channels-usage" data-level={s.usage.level}>
            {s.usage.level !== "ok" && <IconWarning className="h-4 w-4 shrink-0" aria-hidden />}
            <span>
              Today: {num(s.usage.today)} of {num(s.usage.softCap)} incoming chat messages.
              {s.usage.level === "near" && " You are close to today's limit."}
              {s.usage.level === "over" && " Over today's limit. New messages are still saved, but write to us if this keeps happening."}
            </span>
          </div>
        )}
      </Card>

      {s.enabled && (
        <section aria-labelledby="channels-add">
          <h2 id="channels-add" className="mb-2 px-1 text-[12.5px] font-medium uppercase tracking-[0.04em] text-subtle">Add a channel</h2>
          <Card className="divide-y divide-line">
            <div className="flex flex-wrap items-center gap-3 p-4 md:px-5" data-testid="tile-whatsapp">
              <ProviderTile provider="whatsapp" />
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-medium">WhatsApp</p>
                <p className="text-[13px] text-muted">{s.embeddedSignup || !s.canManage ? "A WhatsApp Business number. You sign in with Facebook and pick the number." : "A WhatsApp Business number. Connecting opens once setup with Meta is finished."}</p>
              </div>
              {s.canManage && s.embeddedSignup && (
                <Button onClick={() => void signup.start()} loading={signup.busy} variant={hasWhatsapp ? "outline" : "primary"} size="sm" className="max-sm:w-full">
                  <IconPlug className="h-4 w-4" aria-hidden />{hasWhatsapp ? "Connect another number" : "Connect WhatsApp"}
                </Button>
              )}
              {signup.error && <p role="alert" className="basis-full rounded-lg bg-bad-soft px-3 py-2 text-[13px] text-bad" data-testid="connect-error">{signup.error}</p>}
            </div>
            {s.mock && s.canManage && (
              <div className="flex flex-wrap items-center gap-3 p-4 md:px-5" data-testid="tile-mock">
                <ProviderTile provider="mock" />
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-medium">Test channel</p>
                  <p className="text-[13px] text-muted">Only on this test server. Lets you try chats without a real number.</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => mock.mutate()} loading={mock.isPending} className="max-sm:w-full">Connect test channel</Button>
              </div>
            )}
            {(["messenger", "instagram"] as const).map((p) => (
              <div key={p} className="flex items-center gap-3 p-4 md:px-5" data-testid={`tile-${p}`}>
                <span className="opacity-60"><ProviderTile provider={p} /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-medium text-fg/80">{PROVIDER_LABEL[p]}</p>
                  <p className="text-[13px] text-muted">{p === "messenger" ? "Messages to your Facebook Page." : "Direct messages to your Instagram business account."}</p>
                </div>
                <Badge>Coming soon</Badge>
              </div>
            ))}
          </Card>
        </section>
      )}

      {active.length > 0 && <ChannelList title="Connected" channels={active} canManage={s.canManage} onChange={refresh} />}
      {past.length > 0 && <ChannelList title="Disconnected" channels={past} canManage={false} onChange={refresh} />}
    </div>
  );
}

function ChannelList({ title, channels, canManage, onChange }: { title: string; channels: ChannelSummary[]; canManage: boolean; onChange: () => void }) {
  const [confirm, setConfirm] = useState<ChannelSummary | null>(null);
  const off = useMutation({
    mutationFn: (id: string) => api.post<{ channel: ChannelSummary }>(`/channels/${encodeURIComponent(id)}/disconnect`, {}),
    onSuccess: (r) => { toast.success(`${r.channel.name} disconnected. Its chats stay in the inbox.`); setConfirm(null); onChange(); },
    onError: (e) => toast.error(errorMessage(e, "Couldn't disconnect. Try again.")),
  });
  return (
    <section aria-label={`${title} channels`}>
      <h2 className="mb-2 px-1 text-[12.5px] font-medium uppercase tracking-[0.04em] text-subtle">{title}</h2>
      <Card className="divide-y divide-line">
        {channels.map((c) => (
          <div key={c.id} className="flex flex-wrap items-center gap-3 p-4 md:px-5" data-testid="channel-row">
            <ProviderTile provider={c.provider} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-medium">{c.name}</p>
              <p className="truncate text-[13px] text-muted">{PROVIDER_LABEL[c.provider]}{c.handle && c.handle !== c.name ? ` · ${c.handle}` : ""} · {c.status === "disconnected" && c.disconnectedAt ? `disconnected ${timeAgo(c.disconnectedAt)}` : `connected ${timeAgo(c.connectedAt)}`}</p>
            </div>
            {c.status === "active" && <Badge tone="ok"><IconCheckCircle className="h-3 w-3" aria-hidden />Connected</Badge>}
            {c.status === "error" && <Badge tone="bad"><IconWarning className="h-3 w-3" aria-hidden />Needs attention</Badge>}
            {c.status === "disconnected" && <Badge>Disconnected</Badge>}
            {canManage && c.status !== "disconnected" && <Button variant="ghost" size="sm" onClick={() => setConfirm(c)} aria-label={`Disconnect ${c.name}`}>Disconnect</Button>}
          </div>
        ))}
      </Card>
      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} onConfirm={() => confirm && off.mutate(confirm.id)} busy={off.isPending}
        title={`Disconnect ${confirm?.name ?? "this channel"}?`} confirmLabel="Disconnect"
        description="New messages to this number stop coming in. Every chat and note so far stays in the shared inbox, and you can connect it again later." />
    </section>
  );
}
