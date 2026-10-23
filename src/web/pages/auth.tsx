import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Eye, EyeOff, KeyRound, MailCheck, ShieldCheck, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/web/components/ui/button";
import { Field, Input } from "@/web/components/ui/input";
import { api, ApiError } from "@/web/lib/api";
import { useConfig } from "@/web/lib/queries";
import { useStartDemo } from "@/web/lib/demo";

function useAuthSubmit(path: "/auth/login" | "/auth/signup" | "/auth/login/2fa") {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [ticket, setTicket] = useState<string | null>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const submit = async (body: Record<string, string>) => {
    setLoading(true);
    setError(null);
    setFields({});
    try {
      const res = await api.post<{ mfaRequired?: boolean; ticket?: string; usedRecoveryCode?: boolean }>(path, body);
      if (res?.mfaRequired && res.ticket) { setTicket(res.ticket); return; }
      if (res?.usedRecoveryCode) toast.warning("You used a recovery code", { description: "Generate new codes in Account & security if you're running low." });
      qc.clear();
      const next = params.get("next");
      navigate(next && (next.startsWith("/app") || next.startsWith("/invite/")) ? next : "/app");
    } catch (err) {
      if (err instanceof ApiError && err.code === "mfa_expired") setTicket(null);
      if (err instanceof ApiError && err.fields) setFields(err.fields);
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };
  return { submit, loading, error, fields, ticket };
}

function PasswordInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input {...props} type={show ? "text" : "password"} className="pr-10" />
      <button type="button" onClick={() => setShow((s) => !s)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-subtle hover:text-fg" aria-label={show ? "Hide password" : "Show password"}>
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return <div role="alert" className="rounded-lg border border-bad/25 bg-bad-soft px-3 py-2.5 text-sm text-bad">{message}</div>;
}

function DemoLink() {
  const config = useConfig();
  const demo = useStartDemo();
  if (!config.data?.demoEnabled) return null;
  return (
    <>
      <div className="my-6 flex items-center gap-3 text-xs text-subtle"><span className="h-px flex-1 bg-line" />or<span className="h-px flex-1 bg-line" /></div>
      <Button variant="secondary" className="w-full" onClick={demo.start} loading={demo.loading}><Sparkles className="h-4 w-4" /> Explore a demo workspace</Button>
    </>
  );
}

export function LoginPage() {
  const { submit, loading, error, fields, ticket } = useAuthSubmit("/auth/login");
  const [params] = useSearchParams();
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    submit({ email: String(f.get("email")), password: String(f.get("password")) });
  };
  if (ticket) return <SecondFactor ticket={ticket} />;
  return (
    <div className="rounded-2xl border border-line bg-surface/80 p-7 shadow-pop backdrop-blur">
      <h1 className="text-xl font-semibold tracking-tight">Welcome back</h1>
      <p className="mt-1 text-sm text-muted">Sign in to your MyMail workspace.</p>
      <form className="mt-6 space-y-4" onSubmit={onSubmit} noValidate>
        <FormError message={error} />
        <Field label="Email" error={fields.email}>{(p) => <Input {...p} name="email" type="email" autoComplete="email" placeholder="you@company.com" required autoFocus={!params.get("email")} defaultValue={params.get("email") ?? ""} />}</Field>
        <div className="space-y-1.5">
          <Field label="Password" error={fields.password}>{(p) => <PasswordInput {...p} name="password" autoComplete="current-password" required autoFocus={!!params.get("email")} />}</Field>
          <div className="text-right"><Link to="/forgot-password" className="text-xs text-muted hover:text-fg hover:underline">Forgot password?</Link></div>
        </div>
        <Button type="submit" className="w-full" size="lg" loading={loading}>Sign in</Button>
      </form>
      <DemoLink />
      <p className="mt-6 text-center text-sm text-muted">New to MyMail? <Link to={`/signup${params.get("next") ? `?next=${encodeURIComponent(params.get("next")!)}` : ""}`} className="font-medium text-fg hover:underline">Create an account</Link></p>
    </div>
  );
}

function SecondFactor({ ticket }: { ticket: string }) {
  const { submit, loading, error, fields } = useAuthSubmit("/auth/login/2fa");
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState("");
  return (
    <div className="rounded-2xl border border-line bg-surface/80 p-7 shadow-pop backdrop-blur">
      <div className="grid h-11 w-11 place-items-center rounded-xl border border-line-strong bg-elevated text-brand-hover">{recovery ? <KeyRound className="h-5 w-5" /> : <ShieldCheck className="h-5 w-5" />}</div>
      <h1 className="mt-4 text-xl font-semibold tracking-tight">{recovery ? "Use a recovery code" : "Two-factor authentication"}</h1>
      <p className="mt-1 text-sm text-muted">{recovery ? "Enter one of the codes you saved when you turned on two-factor." : "Enter the 6-digit code from your authenticator app."}</p>
      <form className="mt-6 space-y-4" onSubmit={(e) => { e.preventDefault(); submit({ ticket, code }); }} noValidate>
        <FormError message={error && !fields.code ? error : null} />
        <Field label={recovery ? "Recovery code" : "Code"} error={fields.code}>
          {(p) => <Input {...p} key={String(recovery)} value={code} onChange={(e) => setCode(e.target.value)} autoFocus
            {...(recovery ? { placeholder: "xxxxx-xxxxx", autoComplete: "off" } : { inputMode: "numeric", autoComplete: "one-time-code", placeholder: "123456", maxLength: 7 })}
            className="font-mono tracking-widest" />}
        </Field>
        <Button type="submit" className="w-full" size="lg" loading={loading} disabled={!code.trim()}>Verify</Button>
      </form>
      <button type="button" className="mt-4 w-full text-center text-sm text-muted hover:text-fg" onClick={() => { setRecovery((r) => !r); setCode(""); }}>
        {recovery ? "Use your authenticator app instead" : "Lost your phone? Use a recovery code"}
      </button>
    </div>
  );
}

const card = "rounded-2xl border border-line bg-surface/80 p-7 shadow-pop backdrop-blur";

export function ForgotPasswordPage() {
  const config = useConfig();
  const [email, setEmail] = useState("");
  const send = useMutation({ mutationFn: () => api.post<{ ok: true; deliveryConnected: boolean; devLink?: string }>("/auth/password/forgot", { email }) });
  if (send.isSuccess) {
    return (
      <div className={card}>
        <div className="grid h-11 w-11 place-items-center rounded-xl border border-line-strong bg-elevated text-brand-hover"><MailCheck className="h-5 w-5" /></div>
        <h1 className="mt-4 text-xl font-semibold tracking-tight">Check your inbox</h1>
        <p className="mt-1 text-sm text-muted">If an account exists for <b className="font-medium text-fg">{email}</b>, a reset link is on its way. It works for one hour.</p>
        {!send.data.deliveryConnected && (
          <p className="mt-4 rounded-lg border border-warn/25 bg-warn-soft px-3 py-2 text-sm text-warn">Email delivery isn't connected on this deployment yet, so only addresses hosted on MyMail receive it. Your workspace owner or the platform operator can issue you a reset link.</p>
        )}
        {send.data.devLink && <p className="mt-4 break-all rounded-lg border border-line bg-elevated p-3 text-xs">Development mode: <Link className="text-brand-hover underline" to={new URL(send.data.devLink).pathname}>{send.data.devLink}</Link></p>}
        <Link to="/login" className="mt-6 block text-center text-sm font-medium text-fg hover:underline">Back to sign in</Link>
      </div>
    );
  }
  return (
    <div className={card}>
      <h1 className="text-xl font-semibold tracking-tight">Reset your password</h1>
      <p className="mt-1 text-sm text-muted">We'll email you a link to choose a new one.</p>
      <form className="mt-6 space-y-4" onSubmit={(e) => { e.preventDefault(); send.mutate(); }} noValidate>
        <FormError message={send.error?.message ?? null} />
        <Field label="Email">{(p) => <Input {...p} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoFocus />}</Field>
        <Button type="submit" className="w-full" size="lg" loading={send.isPending} disabled={!email}>Send reset link</Button>
      </form>
      {config.data?.outboundDriver === "log" && <p className="mt-4 text-xs text-subtle">Heads up: email delivery isn't connected on this deployment yet.</p>}
      <Link to="/login" className="mt-6 block text-center text-sm text-muted hover:text-fg">Back to sign in</Link>
    </div>
  );
}

export function ResetPasswordPage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const info = useQuery({ queryKey: ["reset", token], queryFn: () => api.get<{ email: string; mfa: boolean }>(`/auth/password/reset/${token}`), retry: false });
  const [password, setPassword] = useState("");
  const reset = useMutation({
    mutationFn: () => api.post("/auth/password/reset", { token, password }),
    onSuccess: () => { toast.success("Password updated", { description: "Sign in with your new password." }); navigate("/login"); },
  });
  if (info.isPending) return <div className={card}><div className="skeleton h-6 w-2/3" /><div className="skeleton mt-4 h-10" /></div>;
  if (info.error) {
    return (
      <div className={card}>
        <h1 className="text-xl font-semibold tracking-tight">This link has expired</h1>
        <p className="mt-1 text-sm text-muted">{info.error.message}</p>
        <Link to="/forgot-password" className="mt-6 block text-center text-sm font-medium text-fg hover:underline">Request a new link</Link>
      </div>
    );
  }
  const err = reset.error instanceof ApiError ? reset.error : null;
  return (
    <div className={card}>
      <h1 className="text-xl font-semibold tracking-tight">Choose a new password</h1>
      <p className="mt-1 text-sm text-muted">For {info.data.email}. You'll be signed out on every device.</p>
      <form className="mt-6 space-y-4" onSubmit={(e) => { e.preventDefault(); reset.mutate(); }} noValidate>
        <FormError message={err && !err.fields ? err.message : null} />
        <Field label="New password" hint="At least 10 characters." error={err?.fields?.password}>{(p) => <PasswordInput {...p} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />}</Field>
        <Button type="submit" className="w-full" size="lg" loading={reset.isPending} disabled={password.length < 10}>Update password</Button>
      </form>
      {info.data.mfa && <p className="mt-4 text-xs text-subtle">Two-factor stays on. You'll still need your authenticator app to sign in.</p>}
    </div>
  );
}

export function VerifyEmailPage() {
  const { token = "" } = useParams();
  const verify = useQuery({ queryKey: ["verify", token], queryFn: () => api.post<{ email: string }>("/auth/verify-email", { token }), retry: false, staleTime: Infinity });
  if (verify.isPending) return <div className={card}><div className="skeleton h-6 w-2/3" /><div className="skeleton mt-4 h-4" /></div>;
  return (
    <div className={card}>
      {verify.error ? (
        <>
          <h1 className="text-xl font-semibold tracking-tight">We couldn't confirm that link</h1>
          <p className="mt-1 text-sm text-muted">{verify.error.message} You can send a new one from Account & security.</p>
        </>
      ) : (
        <>
          <CheckCircle2 className="h-8 w-8 text-ok" />
          <h1 className="mt-3 text-xl font-semibold tracking-tight">Email confirmed</h1>
          <p className="mt-1 text-sm text-muted">{verify.data.email} is verified. Thanks!</p>
        </>
      )}
      <Link to="/app" className="mt-6 block text-center text-sm font-medium text-fg hover:underline">Open MyMail</Link>
    </div>
  );
}

export function SignupPage() {
  const { submit, loading, error, fields } = useAuthSubmit("/auth/signup");
  const [params] = useSearchParams();
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    submit({ name: String(f.get("name")), email: String(f.get("email")), password: String(f.get("password")), organization: String(f.get("organization") ?? "") });
  };
  return (
    <div className="rounded-2xl border border-line bg-surface/80 p-7 shadow-pop backdrop-blur">
      <h1 className="text-xl font-semibold tracking-tight">Create your account</h1>
      <p className="mt-1 text-sm text-muted">Free for your first domain. No credit card.</p>
      <form className="mt-6 space-y-4" onSubmit={onSubmit} noValidate>
        <FormError message={error && !Object.keys(fields).length ? error : null} />
        <Field label="Your name" error={fields.name}>{(p) => <Input {...p} name="name" autoComplete="name" placeholder="Ada Lovelace" required autoFocus />}</Field>
        <Field label="Work email" error={fields.email}>{(p) => <Input {...p} name="email" type="email" autoComplete="email" placeholder="ada@company.com" required defaultValue={params.get("email") ?? ""} readOnly={!!params.get("invited")} />}</Field>
        <Field label="Password" error={fields.password} hint="At least 10 characters.">{(p) => <PasswordInput {...p} name="password" autoComplete="new-password" required minLength={10} />}</Field>
        {!params.get("invited") && <Field label="Company" hint="Optional — names your workspace." error={fields.organization}>{(p) => <Input {...p} name="organization" autoComplete="organization" placeholder="Analytical Engines Ltd." />}</Field>}
        <Button type="submit" className="w-full" size="lg" loading={loading}>Create account</Button>
      </form>
      <DemoLink />
      <p className="mt-6 text-center text-sm text-muted">Already have an account? <Link to={`/login${params.get("next") ? `?next=${encodeURIComponent(params.get("next")!)}` : ""}`} className="font-medium text-fg hover:underline">Sign in</Link></p>
    </div>
  );
}
