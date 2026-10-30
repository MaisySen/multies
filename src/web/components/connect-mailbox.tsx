import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconAlertCircle, IconCheckCircle, IconChevronDown, IconExternalLink, IconKey, IconLock, IconServer } from "@/web/components/ui/icon";
import { toast } from "sonner";
import { api, ApiError } from "@/web/lib/api";
import { qk } from "@/web/lib/queries";
import { Button } from "@/web/components/ui/button";
import { Field, Input, Select } from "@/web/components/ui/input";
import { cn } from "@/web/lib/cn";
import { CONNECT_PRESETS, PRESET_ORDER, presetForEmail, serversFor, type ConnectionView, type ConnectPresetId, type ConnectSecurity } from "@/shared/mail-connect";

export interface ConnectionsInfo { enabled: boolean; oauth: ("google" | "microsoft")[]; connections: ConnectionView[] }
export const connectionsKey = ["connections"] as const;

export function useConnections() {
  return useQuery({ queryKey: connectionsKey, queryFn: () => api.get<ConnectionsInfo>("/connections"), retry: false });
}

interface ServerFields { host: string; port: string; security: ConnectSecurity }

/**
 * Connect an existing mailbox: the address, the provider (guessed from the address), the app
 * password with the provider's own steps, and the servers for anything else. "Test connection"
 * signs in to both servers without saving; "Connect" tests again, saves and starts the first sync.
 */
export function ConnectMailboxForm({ onConnected, oauth = [], className }: { onConnected?: (c: ConnectionView) => void; oauth?: ConnectionsInfo["oauth"]; className?: string }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [picked, setPicked] = useState<ConnectPresetId | null>(null);
  const guessed = presetForEmail(email);
  const preset: ConnectPresetId = picked ?? guessed ?? (email.includes("@") ? "custom" : "gmail");
  const p = CONNECT_PRESETS[preset];
  const defaults = useMemo(() => serversFor(preset, email), [preset, email]);
  const [advanced, setAdvanced] = useState(false);
  const [username, setUsername] = useState("");
  const [imap, setImap] = useState<ServerFields | null>(null);
  const [smtp, setSmtp] = useState<ServerFields | null>(null);
  const showServers = preset === "custom" || advanced;
  const im = imap ?? { host: defaults.imap.host, port: String(defaults.imap.port), security: defaults.imap.security };
  const sm = smtp ?? { host: defaults.smtp.host, port: String(defaults.smtp.port), security: defaults.smtp.security };
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const body = () => ({
    email: email.trim(), password, preset,
    ...(username.trim() ? { username: username.trim() } : {}),
    ...(showServers ? { imap: { host: im.host.trim(), port: Number(im.port), security: im.security }, smtp: { host: sm.host.trim(), port: Number(sm.port), security: sm.security } } : {}),
  });
  const explain = (e: unknown) => setResult({ ok: false, message: e instanceof ApiError ? e.message : "That didn't work. Check your connection and try again." });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: true }>("/connections/test", body()),
    onSuccess: () => setResult({ ok: true, message: "Both servers accepted the password. Connect to start syncing." }),
    onError: explain,
  });
  const connect = useMutation({
    mutationFn: () => api.post<{ connection: ConnectionView }>("/connections", body()),
    onSuccess: (r) => {
      for (const k of [connectionsKey, qk.mailboxes, qk.overview, qk.dashboard]) qc.invalidateQueries({ queryKey: k });
      toast.success(`${r.connection.email} is connected`);
      setPassword("");
      setResult(null);
      onConnected?.(r.connection);
    },
    onError: explain,
  });
  const busy = test.isPending || connect.isPending;
  const ready = email.includes("@") && password.length > 0 && (!showServers || (im.host && sm.host));
  const submit = (e: FormEvent) => { e.preventDefault(); if (ready) connect.mutate(); };
  const oauthFor = preset === "gmail" || preset === "google_workspace" ? "google" : preset === "outlook" || preset === "microsoft365" ? "microsoft" : null;

  return (
    <form onSubmit={submit} className={cn("space-y-4", className)} data-testid="connect-form" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Email address">{(fp) => (
          <Input {...fp} type="email" autoComplete="email" placeholder="you@gmail.com" value={email} onChange={(e) => { setEmail(e.target.value); setResult(null); setImap(null); setSmtp(null); }} data-testid="connect-email" />
        )}</Field>
        <Field label="Provider">{(fp) => (
          <Select {...fp} value={preset} onChange={(e) => { setPicked(e.target.value as ConnectPresetId); setImap(null); setSmtp(null); setResult(null); }} data-testid="connect-provider">
            {PRESET_ORDER.map((id) => <option key={id} value={id}>{CONNECT_PRESETS[id].label}</option>)}
          </Select>
        )}</Field>
      </div>

      {oauthFor && oauth.includes(oauthFor) && (
        <a href={`/api/connections/oauth/${oauthFor}/start`} className="flex items-center justify-center gap-2 rounded-xl border border-line bg-elevated px-4 py-2.5 text-sm font-medium hover:bg-fill">
          <IconLock className="h-4 w-4" aria-hidden />Sign in with {oauthFor === "google" ? "Google" : "Microsoft"} instead
        </a>
      )}

      <div className="rounded-xl bg-fill px-4 py-3 text-sm text-muted" data-testid="connect-help">
        <div className="flex items-start gap-2">
          <IconKey className="mt-0.5 h-4 w-4 shrink-0 text-subtle" aria-hidden />
          <div className="min-w-0">
            <p>{p.help}</p>
            {p.appPasswordUrl && (
              <a href={p.appPasswordUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 font-medium text-brand hover:underline">
                Make an app password <IconExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
            )}
          </div>
        </div>
      </div>

      <Field label="App password" hint="Stored encrypted. Used only to read and send your mail. Remove the connection to delete it.">{(fp) => (
        <Input {...fp} type="password" autoComplete="off" placeholder="xxxx xxxx xxxx xxxx" value={password} onChange={(e) => { setPassword(e.target.value); setResult(null); }} data-testid="connect-password" />
      )}</Field>

      {preset !== "custom" && (
        <button type="button" onClick={() => setAdvanced((v) => !v)} className="inline-flex items-center gap-1 text-[13px] font-medium text-muted hover:text-fg" aria-expanded={advanced}>
          <IconServer className="h-3.5 w-3.5" aria-hidden />Server settings<IconChevronDown className={cn("h-3.5 w-3.5 transition-transform", advanced && "rotate-180")} aria-hidden />
        </button>
      )}
      {showServers && (
        <div className="space-y-4 rounded-xl border border-line p-4" data-testid="connect-servers">
          <ServerRow label="Incoming mail (IMAP)" value={im} onChange={setImap} testid="imap" />
          <ServerRow label="Outgoing mail (SMTP)" value={sm} onChange={setSmtp} testid="smtp" />
          <Field label="User name" hint="Leave empty to use the email address. A few providers want only the part before the @.">{(fp) => (
            <Input {...fp} autoComplete="off" value={username} placeholder={email || "you@example.com"} onChange={(e) => setUsername(e.target.value)} />
          )}</Field>
        </div>
      )}

      {result && (
        <p role={result.ok ? "status" : "alert"} data-testid="connect-result" className={cn("flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm", result.ok ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad")}>
          {result.ok ? <IconCheckCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <IconAlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
          <span>{result.message}</span>
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="secondary" disabled={!ready || busy} loading={test.isPending} onClick={() => test.mutate()} data-testid="connect-test">Test connection</Button>
        <Button type="submit" disabled={!ready || busy} loading={connect.isPending} data-testid="connect-submit">Connect</Button>
      </div>
    </form>
  );
}

function ServerRow({ label, value, onChange, testid }: { label: string; value: ServerFields; onChange: (v: ServerFields) => void; testid: string }) {
  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_96px_132px]">
      <Field label={label}>{(fp) => <Input {...fp} value={value.host} placeholder={testid === "imap" ? "imap.example.com" : "smtp.example.com"} onChange={(e) => onChange({ ...value, host: e.target.value })} data-testid={`${testid}-host`} />}</Field>
      <Field label="Port">{(fp) => <Input {...fp} inputMode="numeric" value={value.port} onChange={(e) => onChange({ ...value, port: e.target.value.replace(/\D/g, "") })} data-testid={`${testid}-port`} />}</Field>
      <Field label="Security">{(fp) => (
        <Select {...fp} value={value.security} onChange={(e) => onChange({ ...value, security: e.target.value as ConnectSecurity })} data-testid={`${testid}-security`}>
          <option value="tls">SSL/TLS</option>
          <option value="starttls">STARTTLS</option>
        </Select>
      )}</Field>
    </div>
  );
}
