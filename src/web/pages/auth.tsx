import { useState, type FormEvent } from "react";
import { READ_ONLY_MESSAGE } from "@/web/lib/read-only";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Eye, EyeOff, KeyRound, MailCheck, ShieldCheck, Play } from "lucide-react";
import { toast } from "sonner";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/web/components/ui/button";
import { Field, Input } from "@/web/components/ui/input";
import { api, ApiError } from "@/web/lib/api";
import { authClient, unwrap, type AuthProviders } from "@/web/lib/auth-client";
import { useConfig } from "@/web/lib/queries";
import { useStartDemo } from "@/web/lib/demo";

type AuthAction = (body: Record<string, string>) => Promise<{ twoFactorRedirect?: boolean } | unknown>;

/** Runs a sign-in style action, then lands in the app (or where the person was headed). */
function useAuthSubmit(action: AuthAction, opts: { thanks?: boolean } = {}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [needsSecondFactor, setNeedsSecondFactor] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const submit = async (body: Record<string, string>) => {
    setLoading(true);
    setError(null);
    setFields({});
    try {
      const res = (await action(body)) as { twoFactorRedirect?: boolean } | null;
      if (res?.twoFactorRedirect) { setNeedsSecondFactor(true); return; }
      qc.clear();
      const next = params.get("next");
      const dest = next && (next.startsWith("/app") || next.startsWith("/invite/")) ? next : "/app";
      navigate(opts.thanks ? `/thanks?from=signup&next=${encodeURIComponent(dest)}` : dest);
    } catch (err) {
      if (err instanceof ApiError && err.fields) setFields(err.fields);
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };
  return { submit, loading, error, fields, needsSecondFactor };
}

export function useAuthProviders() {
  return useQuery({ queryKey: ["auth-providers"], queryFn: () => api.get<AuthProviders>("/account/providers"), staleTime: Infinity });
}

function safeNext(next: string | null) {
  return next && (next.startsWith("/app") || next.startsWith("/invite/")) ? next : "/app";
}

/**
 * The identity provider's sign in and sign up page (Universal Login). One button each way;
 * the provider offers email and password, passwordless codes, passkeys and social accounts.
 */
function IdentityButtons({ mode, showDivider }: { mode: "signin" | "signup"; showDivider: boolean }) {
  const [params] = useSearchParams();
  const [busy, setBusy] = useState<"signin" | "signup" | null>(null);
  const go = async (which: "signin" | "signup") => {
    setBusy(which);
    const email = params.get("email") ?? undefined;
    try {
      await unwrap(authClient.signIn.social({
        provider: "auth0", callbackURL: safeNext(params.get("next")), errorCallbackURL: "/login?error=oauth",
        ...(email ? { loginHint: email } : {}),
        ...(which === "signup" ? { additionalParams: { screen_hint: "signup" } } : {}),
      }));
    } catch (e) { toast.error(e instanceof Error ? e.message : "Sign in failed"); setBusy(null); }
  };
  const primary = mode === "signup" ? "signup" : "signin";
  const secondary = primary === "signin" ? "signup" : "signin";
  const label = { signin: "Continue with Multies", signup: "Create your account" };
  return (
    <div className="mt-6 space-y-2">
      <Button className="w-full" size="lg" loading={busy === primary} onClick={() => go(primary)} data-testid="idp-primary">{label[primary]}</Button>
      <Button variant="secondary" className="w-full" loading={busy === secondary} onClick={() => go(secondary)} data-testid="idp-secondary">{secondary === "signup" ? "Create account" : "Sign in instead"}</Button>
      <p className="pt-1 text-center text-xs text-subtle">Use your email, a one time code, a passkey, or your Google, Apple or GitHub account.</p>
      {showDivider && <div className="flex items-center gap-3 pt-2 text-xs text-subtle"><span className="h-px flex-1 bg-line" />or use your password<span className="h-px flex-1 bg-line" /></div>}
    </div>
  );
}

/** Direct social sign in, for deployments without the identity provider (self host). */
function SocialButtons() {
  const providers = useAuthProviders();
  const [params] = useSearchParams();
  const [busy, setBusy] = useState<string | null>(null);
  const list = (["google", "github"] as const).filter((p) => providers.data?.[p]);
  if (!list.length) return null;
  const label = { google: "Google", github: "GitHub" };
  const go = async (provider: (typeof list)[number]) => {
    setBusy(provider);
    try { await unwrap(authClient.signIn.social({ provider, callbackURL: safeNext(params.get("next")), errorCallbackURL: "/login?error=oauth" })); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Sign in failed"); setBusy(null); }
  };
  return (
    <div className="mt-6 space-y-2">
      {list.map((p) => (
        <Button key={p} variant="secondary" className="w-full" loading={busy === p} onClick={() => go(p)}>Continue with {label[p]}</Button>
      ))}
      <div className="flex items-center gap-3 pt-2 text-xs text-subtle"><span className="h-px flex-1 bg-line" />or use email<span className="h-px flex-1 bg-line" /></div>
    </div>
  );
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
      <Button variant="secondary" className="w-full" onClick={demo.start} loading={demo.loading}><Play className="h-4 w-4" /> Explore a demo workspace</Button>
    </>
  );
}

export function LoginPage() {
  const { submit, loading, error, fields, needsSecondFactor } = useAuthSubmit((b) => unwrap(authClient.signIn.email({ email: b.email, password: b.password })));
  const [params] = useSearchParams();
  const providers = useAuthProviders();
  const idp = !!providers.data?.idp;
  const password = providers.data ? providers.data.password : false;
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    submit({ email: String(f.get("email")), password: String(f.get("password")) });
  };
  if (needsSecondFactor) return <SecondFactor />;
  return (
    <div className="rounded-2xl border border-line bg-surface/80 p-7 shadow-pop backdrop-blur">
      <h1 className="text-xl font-semibold tracking-tight">Welcome back</h1>
      <p className="mt-1 text-sm text-muted">Sign in to your Multies workspace.</p>
      {params.get("sso") === "required" && <p className="mt-4 rounded-lg border border-line-strong bg-elevated/60 px-3 py-2 text-sm text-muted" role="status">Your workspace requires single sign on. Continue with your company account.</p>}
      {params.get("error") === "oauth" && <div className="mt-4"><FormError message="That sign in didn't complete. Please try again." /></div>}
      {params.get("error") === "read_only" && <div className="mt-4"><FormError message={READ_ONLY_MESSAGE} /></div>}
      {idp && <IdentityButtons mode="signin" showDivider={password} />}
      {!idp && <SocialButtons />}
      {password && (
        <form className="mt-6 space-y-4" onSubmit={onSubmit} noValidate>
          <FormError message={error} />
          <Field label="Email" error={fields.email}>{(p) => <Input {...p} name="email" type="email" autoComplete="email" placeholder="you@company.com" required autoFocus={!idp && !params.get("email")} defaultValue={params.get("email") ?? ""} />}</Field>
          <div className="space-y-1.5">
            <Field label="Password" error={fields.password}>{(p) => <PasswordInput {...p} name="password" autoComplete="current-password" required autoFocus={!idp && !!params.get("email")} />}</Field>
            <div className="text-right"><Link to="/forgot-password" className="text-xs text-muted hover:text-fg hover:underline">Forgot password?</Link></div>
          </div>
          <Button type="submit" className="w-full" size="lg" variant={idp ? "secondary" : undefined} loading={loading}>Sign in</Button>
        </form>
      )}
      <DemoLink />
      {!idp && <p className="mt-6 text-center text-sm text-muted">New to Multies? <Link to={`/signup${params.get("next") ? `?next=${encodeURIComponent(params.get("next")!)}` : ""}`} className="font-medium text-fg hover:underline">Create an account</Link></p>}
    </div>
  );
}

function SecondFactor() {
  const [recovery, setRecovery] = useState(false);
  const { submit, loading, error, fields } = useAuthSubmit((b) =>
    recovery
      ? unwrap(authClient.twoFactor.verifyBackupCode({ code: b.code.trim() }))
      : unwrap(authClient.twoFactor.verifyTotp({ code: b.code.replace(/\s/g, "") })));
  const [code, setCode] = useState("");
  return (
    <div className="rounded-2xl border border-line bg-surface/80 p-7 shadow-pop backdrop-blur">
      <div className="grid h-11 w-11 place-items-center rounded-xl border border-line-strong bg-elevated text-brand-hover">{recovery ? <KeyRound className="h-5 w-5" /> : <ShieldCheck className="h-5 w-5" />}</div>
      <h1 className="mt-4 text-xl font-semibold tracking-tight">{recovery ? "Use a backup code" : "Two-factor authentication"}</h1>
      <p className="mt-1 text-sm text-muted">{recovery ? "Enter one of the backup codes you saved when you turned on two-factor." : "Enter the 6-digit code from your authenticator app."}</p>
      <form className="mt-6 space-y-4" onSubmit={(e) => { e.preventDefault(); submit({ code }); }} noValidate>
        <FormError message={error && !fields.code ? error : null} />
        <Field label={recovery ? "Backup code" : "Code"} error={fields.code}>
          {(p) => <Input {...p} key={String(recovery)} value={code} onChange={(e) => setCode(e.target.value)} autoFocus
            {...(recovery ? { placeholder: "xxxxx-xxxxx", autoComplete: "off" } : { inputMode: "numeric", autoComplete: "one-time-code", placeholder: "123456", maxLength: 7 })}
            className="font-mono tracking-widest" />}
        </Field>
        <Button type="submit" className="w-full" size="lg" loading={loading} disabled={!code.trim()}>Verify</Button>
      </form>
      <button type="button" className="mt-4 w-full text-center text-sm text-muted hover:text-fg" onClick={() => { setRecovery((r) => !r); setCode(""); }}>
        {recovery ? "Use your authenticator app instead" : "Lost your phone? Use a backup code"}
      </button>
    </div>
  );
}

const card = "rounded-2xl border border-line bg-surface/80 p-7 shadow-pop backdrop-blur";

export function ForgotPasswordPage() {
  const providers = useAuthProviders();
  if (providers.data && !providers.data.password) return <ManagedAtSignIn title="Reset your password" body="Choose Continue with Multies, enter your email, then pick Forgot password. We'll email you a link." />;
  return <LocalForgotPassword />;
}

/** Password, reset and verification steps that happen on the sign in page when the identity provider is on. */
function ManagedAtSignIn({ title, body }: { title: string; body: string }) {
  return (
    <div className={card}>
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-sm text-muted">{body}</p>
      <IdentityButtons mode="signin" showDivider={false} />
      <Link to="/login" className="mt-6 block text-center text-sm text-muted hover:text-fg">Back to sign in</Link>
    </div>
  );
}

function LocalForgotPassword() {
  const config = useConfig();
  const [email, setEmail] = useState("");
  const send = useMutation({ mutationFn: () => unwrap(authClient.requestPasswordReset({ email, redirectTo: "/reset-password" })) });
  const deliveryConnected = config.data?.outboundDriver !== "log";
  if (send.isSuccess) {
    return (
      <div className={card}>
        <div className="grid h-11 w-11 place-items-center rounded-xl border border-line-strong bg-elevated text-brand-hover"><MailCheck className="h-5 w-5" /></div>
        <h1 className="mt-4 text-xl font-semibold tracking-tight">Check your inbox</h1>
        <p className="mt-1 text-sm text-muted">If an account exists for <b className="font-medium text-fg">{email}</b>, a reset link is on its way. It works for one hour.</p>
        {!deliveryConnected && (
          <p className="mt-4 rounded-lg border border-warn/25 bg-warn-soft px-3 py-2 text-sm text-warn">Email delivery isn't connected on this deployment yet, so only addresses hosted on Multies receive it. Your workspace owner or the platform operator can issue you a reset link.</p>
        )}
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
  const providers = useAuthProviders();
  if (providers.data && !providers.data.password) return <ManagedAtSignIn title="Reset your password" body="Password resets happen on the sign in page now. Choose Continue with Multies, then Forgot password." />;
  return <LocalResetPassword />;
}

function LocalResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const reset = useMutation({
    mutationFn: () => unwrap(authClient.resetPassword({ token, newPassword: password })),
    onSuccess: () => { toast.success("Password updated", { description: "Sign in with your new password." }); navigate("/login"); },
  });
  if (!token || params.get("error")) {
    return (
      <div className={card}>
        <h1 className="text-xl font-semibold tracking-tight">This link has expired</h1>
        <p className="mt-1 text-sm text-muted">Reset links work once, for one hour.</p>
        <Link to="/forgot-password" className="mt-6 block text-center text-sm font-medium text-fg hover:underline">Request a new link</Link>
      </div>
    );
  }
  return (
    <div className={card}>
      <h1 className="text-xl font-semibold tracking-tight">Choose a new password</h1>
      <p className="mt-1 text-sm text-muted">You'll be signed out on every device.</p>
      <form className="mt-6 space-y-4" onSubmit={(e) => { e.preventDefault(); reset.mutate(); }} noValidate>
        <FormError message={reset.error?.message ?? null} />
        <Field label="New password" hint="At least 10 characters.">{(p) => <PasswordInput {...p} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />}</Field>
        <Button type="submit" className="w-full" size="lg" loading={reset.isPending} disabled={password.length < 10}>Update password</Button>
      </form>
      <p className="mt-4 text-xs text-subtle">If two-factor is on, it stays on.</p>
    </div>
  );
}

/** Where the emailed verification link lands after Better Auth confirms it. */
export function EmailVerifiedPage() {
  const [params] = useSearchParams();
  const failed = !!params.get("error");
  return (
    <div className={card}>
      {failed ? (
        <>
          <h1 className="text-xl font-semibold tracking-tight">We couldn't confirm that link</h1>
          <p className="mt-1 text-sm text-muted">It may have expired. Send a new one from Account & security.</p>
        </>
      ) : (
        <>
          <CheckCircle2 className="h-8 w-8 text-ok" />
          <h1 className="mt-3 text-xl font-semibold tracking-tight">Email confirmed</h1>
          <p className="mt-1 text-sm text-muted">Your address is verified.</p>
        </>
      )}
      <Link to="/app" className="mt-6 block text-center text-sm font-medium text-fg hover:underline">Open Multies</Link>
    </div>
  );
}

export function SignupPage() {
  const providers = useAuthProviders();
  const [params] = useSearchParams();
  if (providers.data?.idp && !providers.data.password) {
    return (
      <div className={card}>
        <h1 className="text-xl font-semibold tracking-tight">Create your account</h1>
        <p className="mt-1 text-sm text-muted">Free for startups and small teams. No credit card.</p>
        <IdentityButtons mode="signup" showDivider={false} />
        <p className="mt-4 text-center text-xs text-subtle">
          By creating an account you agree to the <Link to="/terms" className="underline hover:text-fg">Terms</Link>, <Link to="/acceptable-use" className="underline hover:text-fg">Acceptable use policy</Link> and <Link to="/privacy" className="underline hover:text-fg">Privacy policy</Link>.
        </p>
        <DemoLink />
        <p className="mt-6 text-center text-sm text-muted">Already have an account? <Link to={`/login${params.get("next") ? `?next=${encodeURIComponent(params.get("next")!)}` : ""}`} className="font-medium text-fg hover:underline">Sign in</Link></p>
      </div>
    );
  }
  return <LocalSignup idp={!!providers.data?.idp} />;
}

function LocalSignup({ idp }: { idp: boolean }) {
  const { submit, loading, error, fields } = useAuthSubmit(async (b) => {
    await unwrap(authClient.signUp.email({ name: b.name, email: b.email, password: b.password, callbackURL: "/email-verified" }));
    await api.get("/account/me"); // creates the personal workspace
    if (b.organization.trim()) await api.patch("/org", { name: b.organization.trim() });
    return null;
  }, { thanks: true });
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
      {idp && <IdentityButtons mode="signup" showDivider />}
      <form className="mt-6 space-y-4" onSubmit={onSubmit} noValidate>
        <FormError message={error && !Object.keys(fields).length ? error : null} />
        <Field label="Your name" error={fields.name}>{(p) => <Input {...p} name="name" autoComplete="name" placeholder="Ada Lovelace" required autoFocus />}</Field>
        <Field label="Work email" error={fields.email}>{(p) => <Input {...p} name="email" type="email" autoComplete="email" placeholder="ada@company.com" required defaultValue={params.get("email") ?? ""} readOnly={!!params.get("invited")} />}</Field>
        <Field label="Password" error={fields.password} hint="At least 10 characters.">{(p) => <PasswordInput {...p} name="password" autoComplete="new-password" required minLength={10} />}</Field>
        {!params.get("invited") && <Field label="Company" hint="Optional. Names your workspace." error={fields.organization}>{(p) => <Input {...p} name="organization" autoComplete="organization" placeholder="Analytical Engines Ltd." />}</Field>}
        <Button type="submit" className="w-full" size="lg" loading={loading}>Create account</Button>
        <p className="text-center text-xs text-subtle">
          By creating an account you agree to the <Link to="/terms" className="underline hover:text-fg">Terms</Link>, <Link to="/acceptable-use" className="underline hover:text-fg">Acceptable use policy</Link> and <Link to="/privacy" className="underline hover:text-fg">Privacy policy</Link>.
        </p>
      </form>
      <DemoLink />
      <p className="mt-6 text-center text-sm text-muted">Already have an account? <Link to={`/login${params.get("next") ? `?next=${encodeURIComponent(params.get("next")!)}` : ""}`} className="font-medium text-fg hover:underline">Sign in</Link></p>
    </div>
  );
}
