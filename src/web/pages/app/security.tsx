import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Download, KeyRound, Laptop, LogOut, MailWarning, ShieldCheck, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { ApiError } from "@/web/lib/api";
import { authClient, unwrap } from "@/web/lib/auth-client";
import { describeUserAgent } from "@/shared/user-agent";
import { qk, useConfig, useMe } from "@/web/lib/queries";
import { Badge, CopyButton, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input } from "@/web/components/ui/input";
import { QrCode } from "@/web/components/qr";
import { timeAgo } from "@/web/lib/format";
import { AccountSection, Section } from "./settings";

/** Privacy rights (APP 12, GDPR Articles 15 and 20): a copy of everything held about you. */
function YourDataSection() {
  return (
    <Section title="Your data" description="Download a copy of what MyMail holds about you: profile, sign-in methods, devices, workspaces and your activity, as JSON. To delete your account, use Delete account above.">
      <div className="flex flex-wrap items-center gap-3">
        <a href="/api/account/export" download className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-3 text-sm font-medium hover:bg-hover">
          <Download className="h-4 w-4" aria-hidden />Download my data
        </a>
        <a href="/privacy" className="text-sm text-muted hover:text-fg hover:underline">Privacy policy</a>
      </div>
    </Section>
  );
}

/** Security state comes from the session (Better Auth): verified email and 2FA. */
const useSecurity = () => {
  const me = useMe();
  return { isPending: me.isPending, data: me.data ? { emailVerified: me.data.user.emailVerified, twoFactor: { enabled: me.data.user.twoFactor } } : undefined };
};

export function AccountSettings() {
  return (
    <div className="space-y-6">
      <ProfileSection />
      <AccountSection />
      <TwoFactorSection />
      <DevicesSection />
      <YourDataSection />
    </div>
  );
}

function ProfileSection() {
  const me = useMe();
  const sec = useSecurity();
  const config = useConfig();
  const qc = useQueryClient();
  const [name, setName] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => unwrap(authClient.updateUser({ name: name ?? undefined })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.me }); setName(null); toast.success("Name updated"); },
    onError: (e) => toast.error(e.message),
  });
  const resend = useMutation({
    mutationFn: () => unwrap(authClient.sendVerificationEmail({ email: me.data!.user.email, callbackURL: "/email-verified" })),
    onSuccess: () => {
      if (config.data?.outboundDriver !== "log") toast.success("Check your inbox", { description: `We sent a link to ${me.data?.user.email}.` });
      else toast("Email delivery isn't connected yet", { description: "Verification emails go out once an email provider is configured." });
    },
    onError: (e) => toast.error(e.message),
  });
  const value = name ?? me.data?.user.name ?? "";
  return (
    <Section title="Profile" description="How you appear to your team.">
      <form className="max-w-md space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Name">{(p) => <Input {...p} value={value} onChange={(e) => setName(e.target.value)} autoComplete="name" />}</Field>
        <div className="space-y-1.5">
          <div className="text-[13px] font-medium text-fg/90">Email</div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">{me.data?.user.email}</span>
            {sec.isPending ? <Skeleton className="h-5 w-16" /> : sec.data?.emailVerified
              ? <Badge tone="ok"><CheckCircle2 className="h-3 w-3" />Verified</Badge>
              : <Badge tone="warn"><MailWarning className="h-3 w-3" />Not verified</Badge>}
          </div>
          {sec.data && !sec.data.emailVerified && (
            <p className="text-xs text-subtle">
              {config.data?.outboundDriver === "log" ? "Verification emails go out once email delivery is connected. " : "Didn't get the email? "}
              <button type="button" className="font-medium text-brand-hover hover:underline disabled:opacity-50" disabled={resend.isPending} onClick={() => resend.mutate()}>Send a new link</button>
            </p>
          )}
        </div>
        {name !== null && name !== me.data?.user.name && <Button type="submit" variant="secondary" loading={save.isPending} disabled={!value.trim()}>Save name</Button>}
      </form>
    </Section>
  );
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  const text = codes.join("\n");
  const download = () => {
    const url = URL.createObjectURL(new Blob([`MyMail backup codes\nEach code works once.\n\n${text}\n`], { type: "text/plain" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: "mymail-backup-codes.txt" });
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div>
      <ul className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-surface p-4 font-mono text-sm" data-testid="recovery-codes">
        {codes.map((c) => <li key={c} className="tabular-nums">{c}</li>)}
      </ul>
      <div className="mt-3 flex gap-2">
        <CopyButton value={text} label="Copy all" />
        <button type="button" onClick={download} className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-elevated px-2 text-xs text-muted hover:border-line-strong hover:text-fg"><Download className="h-3.5 w-3.5" />Download</button>
      </div>
      <p className="mt-3 text-xs text-subtle">Keep these somewhere safe, like a password manager. Each one signs you in once if you lose your phone. They won't be shown again.</p>
    </div>
  );
}

function TwoFactorSection() {
  const sec = useSecurity();
  const qc = useQueryClient();
  const [setup, setSetup] = useState<{ uri: string; secret: string; backupCodes: string[] } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [pwFor, setPwFor] = useState<"enable" | "disable" | "regenerate" | null>(null);
  const [password, setPassword] = useState("");
  const done = () => { setPwFor(null); setPassword(""); qc.invalidateQueries({ queryKey: qk.me }); };
  const withPassword = useMutation({
    mutationFn: async () => {
      if (pwFor === "enable") {
        const r = await unwrap(authClient.twoFactor.enable({ password }));
        if (r.method !== "totp") throw new ApiError(500, "unexpected", "Two-factor setup returned an unexpected response.");
        setSetup({ uri: r.totpURI, secret: new URL(r.totpURI).searchParams.get("secret") ?? "", backupCodes: r.backupCodes });
        setCode("");
      } else if (pwFor === "disable") {
        await unwrap(authClient.twoFactor.disable({ password }));
        toast.success("Two-factor authentication is off");
      } else {
        setCodes((await unwrap(authClient.twoFactor.generateBackupCodes({ password }))).backupCodes);
      }
    },
    onSuccess: done,
  });
  const verify = useMutation({
    mutationFn: () => unwrap(authClient.twoFactor.verifyTotp({ code: code.replace(/\s/g, "") })),
    onSuccess: () => { setCodes(setup!.backupCodes); setSetup(null); qc.invalidateQueries({ queryKey: qk.me }); },
  });
  const tf = sec.data?.twoFactor;
  return (
    <Section title="Two-factor authentication" description="A code from an authenticator app (1Password, Google Authenticator, Authy) every time you sign in.">
      {sec.isPending ? <Skeleton className="h-16 max-w-md" /> : tf?.enabled ? (
        <div className="max-w-md space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-ok/20 bg-ok-soft p-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 text-ok" />
            <div className="text-sm"><div className="font-medium text-fg">Two-factor is on</div>
              <div className="text-muted">Sign-ins ask for a code from your authenticator app.</div></div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setPwFor("regenerate")}><KeyRound className="h-4 w-4" />New backup codes</Button>
            <Button variant="ghost" onClick={() => setPwFor("disable")}>Turn off</Button>
          </div>
        </div>
      ) : (
        <div className="max-w-md">
          <p className="text-sm text-muted">Your account is protected by your password only.</p>
          <Button className="mt-4" onClick={() => setPwFor("enable")}><ShieldCheck className="h-4 w-4" />Set up two-factor</Button>
        </div>
      )}

      <Dialog open={!!setup} onClose={() => setSetup(null)} title="Set up two-factor authentication" description="Scan the code with your authenticator app, then enter the 6-digit code it shows."
        footer={<><Button variant="secondary" onClick={() => setSetup(null)}>Cancel</Button><Button loading={verify.isPending} disabled={code.replace(/\s/g, "").length !== 6} onClick={() => verify.mutate()}>Turn on</Button></>}>
        {setup && (
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); verify.mutate(); }}>
            <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
              <QrCode value={setup.uri} label="QR code for your authenticator app" />
              <div className="min-w-0 text-sm">
                <p className="text-muted">Can't scan? Enter this key instead:</p>
                <code className="mt-1.5 block break-all rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-xs" data-testid="totp-secret">{setup.secret.match(/.{1,4}/g)?.join(" ")}</code>
                <CopyButton value={setup.secret} label="Copy key" className="mt-2" />
              </div>
            </div>
            <Field label="6-digit code" error={verify.error instanceof ApiError ? verify.error.message : undefined}>
              {(p) => <Input {...p} inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} placeholder="123 456" className="font-mono tracking-widest" autoFocus />}
            </Field>
          </form>
        )}
      </Dialog>

      <Dialog open={!!codes} onClose={() => setCodes(null)} title="Save your backup codes" footer={<Button onClick={() => setCodes(null)}>I've saved them</Button>}>
        {codes && <RecoveryCodes codes={codes} />}
      </Dialog>

      <Dialog open={!!pwFor} onClose={() => setPwFor(null)}
        title={pwFor === "disable" ? "Turn off two-factor?" : pwFor === "enable" ? "Set up two-factor" : "Generate new backup codes?"}
        description={pwFor === "disable" ? "Your account will be protected by your password only." : pwFor === "enable" ? "Confirm your password to start." : "Your old backup codes stop working."}
        footer={<><Button variant="secondary" onClick={() => setPwFor(null)}>Cancel</Button><Button variant={pwFor === "disable" ? "danger" : "primary"} loading={withPassword.isPending} disabled={!password} onClick={() => withPassword.mutate()}>{pwFor === "disable" ? "Turn off" : "Continue"}</Button></>}>
        <form onSubmit={(e) => { e.preventDefault(); if (password) withPassword.mutate(); }}>
          <Field label="Your password" error={withPassword.error instanceof ApiError ? withPassword.error.message : undefined}>
            {(p) => <Input {...p} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />}
          </Field>
        </form>
      </Dialog>
    </Section>
  );
}

interface SessionRow { id: string; token: string; ipAddress?: string | null; userAgent?: string | null; createdAt: string | Date; updatedAt: string | Date }

function DevicesSection() {
  const qc = useQueryClient();
  const current = useQuery({ queryKey: ["session"], queryFn: () => unwrap(authClient.getSession()) });
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => unwrap(authClient.listSessions()) as Promise<SessionRow[]> });
  const revoke = useMutation({
    mutationFn: (token: string) => unwrap(authClient.revokeSession({ token })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["sessions"] }); toast.success("Signed out that device"); },
    onError: (e) => toast.error(e.message),
  });
  const revokeAll = useMutation({
    mutationFn: () => unwrap(authClient.revokeOtherSessions()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["sessions"] }); toast.success("Signed out everywhere else"); },
  });
  const rows = (sessions.data ?? [])
    .map((s) => ({ ...s, current: s.token === current.data?.session.token, device: describeUserAgent(s.userAgent) }))
    .sort((a, b) => Number(b.current) - Number(a.current) || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const others = rows.filter((s) => !s.current).length;
  return (
    <Section title="Devices" description="Where you're signed in. Sessions end after 30 days without activity.">
      {sessions.isPending ? <Skeleton className="h-24" /> : (
        <>
          <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Signed-in devices">
            {rows.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-3.5 py-3">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line bg-elevated text-muted">{s.device.mobile ? <Smartphone className="h-4 w-4" /> : <Laptop className="h-4 w-4" />}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium">{s.device.browser} on {s.device.os}{s.current && <Badge tone="ok">This device</Badge>}</div>
                  <div className="truncate text-xs text-muted">{s.ipAddress || "Unknown IP"} · signed in {timeAgo(String(s.createdAt))} · active {timeAgo(String(s.updatedAt))}</div>
                </div>
                {!s.current && <Button size="sm" variant="ghost" loading={revoke.isPending && revoke.variables === s.token} onClick={() => revoke.mutate(s.token)} aria-label={`Sign out ${s.device.browser} on ${s.device.os}`}><LogOut className="h-3.5 w-3.5" />Sign out</Button>}
              </li>
            ))}
          </ul>
          {others > 0 && <Button className="mt-3" variant="secondary" size="sm" loading={revokeAll.isPending} onClick={() => revokeAll.mutate()}>Sign out all other devices</Button>}
        </>
      )}
    </Section>
  );
}
