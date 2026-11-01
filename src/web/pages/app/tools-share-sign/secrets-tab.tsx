/**
 * R88: Tools > Secure share > Secret links, and the form Mail compose's "Send securely" reuses. Text or a small file is
 * encrypted in this browser; Multies keeps only the ciphertext, and the key rides in the link after "#".
 * Hidden unless GET /api/tools lists the "secrets" feature.
 */
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { Button } from "@/web/components/ui/button";
import { Input, Select, Textarea } from "@/web/components/ui/input";
import { Badge, Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { Dialog } from "@/web/components/ui/dialog";
import { IconCopy, IconFile, IconKey, IconLock, IconShieldCheck, IconTrash } from "@/web/components/ui/icon";
import { encryptSecret, secretLink } from "@/web/lib/secret-crypto";
import { SECRET_EXPIRY_CHOICES, SECRET_MAX_FILE_BYTES, SECRET_MAX_TEXT, SECRET_VIEW_CHOICES, type SecretInfo } from "@/shared/secure-share";
import { LoadErrorInline } from "@/web/components/load-error-t1g";

const MB = 1024 * 1024;
const sizeOf = (n: number) => (n < MB ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / MB).toFixed(1)} MB`);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const STATUS: Record<SecretInfo["status"], { label: string; tone: "ok" | "neutral" | "warn" | "bad" | "brand" }> = {
  waiting: { label: "Not opened yet", tone: "brand" }, opened: { label: "Opened", tone: "ok" }, burned: { label: "Opened and deleted", tone: "neutral" },
  expired: { label: "Expired", tone: "neutral" }, revoked: { label: "Turned off", tone: "neutral" }, paused: { label: "Paused after reports", tone: "bad" },
};

export interface MadeSecret { link: string; info: SecretInfo }

/** The form. `initialText` or `initialFile` prefill it (Send securely); `onMade` gets the full link with its key. */
export function SecretForm({ initialText = "", initialFile = null, compact, onMade, submitLabel = "Create secret link" }: {
  initialText?: string; initialFile?: File | null; compact?: boolean; onMade: (m: MadeSecret) => void; submitLabel?: string;
}) {
  const [mode, setMode] = useState<"text" | "file">(initialFile ? "file" : "text");
  const [text, setText] = useState(initialText);
  const [file, setFile] = useState<File | null>(initialFile);
  const [views, setViews] = useState("1");
  const [expires, setExpires] = useState(String(7 * 86_400));
  const [pass, setPass] = useState("");
  const [label, setLabel] = useState("");
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const fileBad = file && file.size > SECRET_MAX_FILE_BYTES ? `Files can be up to ${sizeOf(SECRET_MAX_FILE_BYTES)} here. Use Share files for bigger ones.` : null;
  const ready = mode === "text" ? text.trim().length > 0 && text.length <= SECRET_MAX_TEXT : !!file && !fileBad;

  const create = async () => {
    setError(null); setBusy(true);
    try {
      const plain = mode === "text" ? { kind: "text" as const, text } : { kind: "file" as const, bytes: new Uint8Array(await file!.arrayBuffer()), name: file!.name, type: file!.type };
      const { ciphertext, key } = await encryptSecret(plain, pass || null);
      const r = await api.post<{ secret: SecretInfo }>("/tools/secrets", { kind: mode, ciphertext, label: label || (mode === "file" ? file!.name : null), passphrase: !!pass, maxViews: Number(views), expiresInSeconds: Number(expires), notify });
      onMade({ link: secretLink(r.secret.url!, key), info: r.secret });
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4" data-testid="secret-form">
      <div role="tablist" aria-label="What to send" className="inline-flex rounded-lg bg-fill p-0.5 text-[13px]">
        {(["text", "file"] as const).map((m) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
            className={`h-8 rounded-md px-3 font-medium transition-colors max-sm:min-h-11 ${mode === m ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"}`}>{m === "text" ? "Text" : "A file"}</button>
        ))}
      </div>
      {mode === "text" ? (
        <label className="block space-y-1 text-[13px] font-medium">Secret
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={compact ? 4 : 5} maxLength={SECRET_MAX_TEXT} placeholder="A password, a bank account number, a key" className="font-mono" data-testid="secret-text" autoComplete="off" spellCheck={false} />
          <span className="block text-right text-[11.5px] font-normal text-subtle">{text.length.toLocaleString()} of {SECRET_MAX_TEXT.toLocaleString()}</span>
        </label>
      ) : (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-line-strong px-4 py-4">
          <IconFile className="h-5 w-5 text-muted" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-sm">{file ? <><span className="font-medium">{file.name}</span> <span className="text-muted">{sizeOf(file.size)}</span></> : <span className="text-muted">One file up to {sizeOf(SECRET_MAX_FILE_BYTES)}</span>}</span>
          <input ref={input} type="file" className="hidden" data-testid="secret-file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <Button variant="outline" size="sm" onClick={() => input.current?.click()}>{file ? "Choose another" : "Choose a file"}</Button>
          {fileBad && <p className="w-full text-[13px] text-bad" role="alert">{fileBad}</p>}
        </div>
      )}
      <div className={`grid gap-4 ${compact ? "grid-cols-2" : "sm:grid-cols-3"}`}>
        <label className="space-y-1 text-[13px] font-medium">Can be opened
          <Select value={views} onChange={(e) => setViews(e.target.value)} data-testid="secret-views">{SECRET_VIEW_CHOICES.map((n) => <option key={n} value={n}>{n === 1 ? "Once" : `${n} times`}</option>)}</Select>
        </label>
        <label className="space-y-1 text-[13px] font-medium">Deleted after
          <Select value={expires} onChange={(e) => setExpires(e.target.value)}>{SECRET_EXPIRY_CHOICES.map((c) => <option key={c.seconds} value={c.seconds}>{c.label}</option>)}</Select>
        </label>
        <label className={`space-y-1 text-[13px] font-medium ${compact ? "col-span-2" : ""}`}>Passphrase <span className="font-normal text-muted">(optional)</span>
          <Input type="password" autoComplete="new-password" maxLength={200} value={pass} onChange={(e) => setPass(e.target.value)} data-testid="secret-pass" />
        </label>
        {!compact && (
          <label className="space-y-1 text-[13px] font-medium sm:col-span-3">Label for you <span className="font-normal text-muted">(optional, only you see it; never the secret itself)</span>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="Wifi password for Sam" />
          </label>
        )}
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />Email me when it is opened</label>
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={create} loading={busy} disabled={!ready} data-testid="secret-create"><IconLock className="h-4 w-4" />{submitLabel}</Button>
        <span className="flex items-center gap-1.5 text-[12.5px] text-muted"><IconShieldCheck className="h-3.5 w-3.5" aria-hidden />Encrypted on this device. Multies can't read it.</span>
      </div>
    </div>
  );
}

function SecretRow({ s }: { s: SecretInfo }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const detail = useQuery({ queryKey: ["tools-secrets", s.id], enabled: open, queryFn: () => api.get<SecretInfo>(`/tools/secrets/${s.id}`) });
  const revoke = useMutation({
    mutationFn: () => api.del<SecretInfo>(`/tools/secrets/${s.id}`),
    onSuccess: () => { setConfirm(false); toast.success("Secret turned off and deleted"); void qc.invalidateQueries({ queryKey: ["tools-secrets"] }); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const st = STATUS[s.status];
  const live = s.status === "waiting" || s.status === "opened";
  return (
    <li className="border-b border-line py-3 last:border-0" data-testid="secret-row">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1 truncate font-medium">{s.label || (s.kind === "file" ? "A file" : "A text secret")}</span>
        <Badge tone={st.tone}>{st.label}</Badge>
        {s.hasPassphrase && <Badge><IconKey className="h-3 w-3" />Passphrase</Badge>}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
        <span>Opened {s.views} of {s.maxViews === 1 ? "1 time" : `${s.maxViews} times`}</span>
        <span>Made {when(s.createdAt)}</span>
        {live && <span>Deleted {when(s.expiresAt)} at the latest</span>}
        <span className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>{open ? "Hide opens" : "Opens"}</Button>
          {live && <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}><IconTrash className="h-3.5 w-3.5" />Turn off</Button>}
        </span>
      </div>
      {open && (
        <div className="mt-2 overflow-x-auto rounded-lg bg-fill p-3 text-[13px]">
          {detail.isLoading ? <Skeleton className="h-4 w-40" /> : !detail.data?.opens?.length ? <p className="text-muted">Not opened yet.</p> : (
            <table className="w-full min-w-[320px]"><thead><tr className="text-left text-muted"><th className="py-1 font-medium">When</th><th className="font-medium">Where</th><th className="font-medium">Browser</th></tr></thead>
              <tbody>{detail.data.opens.map((o, i) => <tr key={i}><td className="py-1">{when(o.at)}</td><td>{[o.region, o.country].filter(Boolean).join(", ") || "Unknown"}</td><td>{o.agent ?? "Unknown"}</td></tr>)}</tbody></table>
          )}
        </div>
      )}
      <Dialog open={confirm} onClose={() => setConfirm(false)} title="Turn off this secret?" description="The link stops working and the secret is deleted for good. You can't undo this."
        footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>Keep it</Button><Button variant="danger" loading={revoke.isPending} onClick={() => revoke.mutate()}>Turn off and delete</Button></>} />
    </li>
  );
}

/** The link, shown once, with a plain warning. */
export function MadeSecretCard({ made, onAnother }: { made: MadeSecret; onAnother?: () => void }) {
  return (
    <div className="space-y-3" data-testid="secret-made">
      <p className="font-medium">Your secret link is ready</p>
      <div className="flex gap-2 max-sm:flex-col">
        <Input readOnly value={made.link} aria-label="Secret link" onFocus={(e) => e.currentTarget.select()} className="w-full font-mono text-[13px]" data-testid="secret-link" />
        <Button variant="outline" onClick={() => { void navigator.clipboard?.writeText(made.link); toast.success("Link copied"); }}><IconCopy className="h-4 w-4" />Copy</Button>
      </div>
      <p className="text-[13px] text-muted">Copy it now: the key is only in this link, so it can't be shown again. {made.info.maxViews === 1 ? "It opens once, then it is deleted." : `It opens ${made.info.maxViews} times, then it is deleted.`}{made.info.hasPassphrase ? " Send the passphrase another way, like a call or a text." : ""}</p>
      {onAnother && <Button variant="ghost" size="sm" onClick={onAnother}>Make another secret</Button>}
    </div>
  );
}

export function SecretsTab() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["tools-secrets"], queryFn: () => api.get<{ secrets: SecretInfo[] }>("/tools/secrets") });
  const [made, setMade] = useState<MadeSecret | null>(null);
  const [formKey, setFormKey] = useState(0);
  return (
    <div className="space-y-5" data-testid="secrets-tab">
      <Card className="space-y-4 p-5">
        {made ? <MadeSecretCard made={made} onAnother={() => { setMade(null); setFormKey((k) => k + 1); }} /> : (
          <>
            <div className="flex items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-fill text-muted" aria-hidden><IconLock className="h-4 w-4" /></span>
              <div><p className="font-medium">Send a password or a file that deletes itself</p><p className="text-[13px] text-muted">It is locked on this device before it leaves. The person sees a warning first, opens it, and then it is gone.</p></div>
            </div>
            <SecretForm key={formKey} onMade={(m) => { setMade(m); void qc.invalidateQueries({ queryKey: ["tools-secrets"] }); }} />
          </>
        )}
      </Card>
      <section>
        <h2 className="mb-2 text-[15px] font-semibold">Your secret links</h2>
        <Card className="px-5 py-1">
          {list.isLoading ? <div className="space-y-3 py-4"><Skeleton className="h-5 w-2/3" /><Skeleton className="h-4 w-1/3" /></div>
            : list.isError ? <LoadErrorInline onRetry={() => list.refetch()} />
              : !list.data?.secrets.length ? <EmptyState className="py-8" icon={<IconLock />} title="No secret links yet" body="Make one above. You'll see here when it is opened." />
                : <ul>{list.data.secrets.map((s) => <SecretRow key={s.id} s={s} />)}</ul>}
        </Card>
        <p className="mt-3 text-[12px] text-muted">Multies keeps only the locked copy and deletes it when the secret is opened for the last time, expires or is turned off. The open log keeps the time, the region and the browser, never the full address.</p>
      </section>
    </div>
  );
}
