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
import { authClient, unwrap } from "@/web/lib/auth-client";
import { useConfig } from "@/web/lib/queries";
import { authProvidersQuery } from "@/web/lib/auth-providers";
import { useStartDemo } from "@/web/lib/demo";
import { SocialSignInButtons } from "@/web/components/social-sign-in";
import { GitHubLogo, GoogleSignInButton, ProviderButton } from "@/web/components/google-button";
import { browserTimeZone } from "@/web/lib/format";
import { cleanLocale, guessCountry } from "@/shared/locale";

/** Where people land after signing in (round 21): My Work, what is waiting on them today. */
export const HOME = "/app/my-work";

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
      const dest = next && (next.startsWith("/app") || next.startsWith("/invite/") || next.startsWith("/oauth/authorize?")) ? next : HOME;
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
  return useQuery(authProvidersQuery); // R30: shared with the auth layout and the boot prefetch
}

function safeNext(next: string | null) {
  return next && (next.startsWith("/app") || next.startsWith("/invite/") || next.startsWith("/oauth/authorize?")) ? next : HOME;
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
      {/* Round 25: Google and Microsoft straight through the identity provider, when this deployment turns them on. */}
      <div className="pt-2"><SocialSignInButtons callbackURL={safeNext(params.get("next"))} loginHint={params.get("email") ?? undefined} /></div>
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
        p === "google"
          ? <GoogleSignInButton key={p} loading={busy === p} disabled={!!busy && busy !== p} onClick={() => go(p)} data-testid="social-google" />
          : <ProviderButton key={p} logo={<GitHubLogo />} loading={busy === p} disabled={!!busy && busy !== p} onClick={() => go(p)} data-testid={`social-${p}`}>Continue with {label[p]}</ProviderButton>
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

/** After sign up: the account exists but its email isn't confirmed yet. Says so plainly and can send the link again. */
function VerifyEmailNotice() {
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>();
  const resend = useMutation({ mutationFn: (address: string) => api.post("/account/resend-verification", { email: address }) });
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const address = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) { setFieldError("Enter the email you signed up with."); return; }
    setFieldError(undefined);
    resend.mutate(address);
  };
  const serverFields = resend.error instanceof ApiError ? resend.error.fields : undefined;
  return (
    <div className="rounded-2xl border border-line bg-surface/80 p-7 shadow-pop backdrop-blur" data-testid="verify-email">
      <div className="grid h-11 w-11 place-items-center rounded-full bg-brand/10 text-accent" aria-hidden><MailCheck className="h-5 w-5" /></div>
      <h1 className="mt-4 text-[24px] font-semibold leading-tight tracking-[-0.02em]">Check your email to verify your account</h1>
      <p className="mt-2 text-sm text-muted">Your account is created. We sent a confirmation link to the address you signed up with. Open it, then come back and sign in.</p>
      <form className="mt-6 space-y-3" onSubmit={onSubmit} noValidate>
        {resend.isSuccess && <p role="status" className="rounded-lg border border-ok/25 bg-ok-soft px-3 py-2.5 text-sm text-ok">If that address is waiting for confirmation, a new link is on its way. Check your spam folder too.</p>}
        {resend.error && !serverFields && <FormError message={resend.error.message} />}
        <Field label="Didn't get it? Send the link again" error={fieldError ?? serverFields?.email}>{(p) => <Input {...p} name="email" type="email" autoComplete="email" inputMode="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Button type="submit" variant="secondary" className="w-full" loading={resend.isPending} data-testid="resend-verification">{resend.isPending ? "Sending" : "Resend link"}</Button>
      </form>
      <Link to="/login" replace className="mt-4 block text-center text-sm font-medium text-accent hover:underline">I've confirmed it, sign in</Link>
    </div>
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
  // The identity provider holds back a new password account until its email is confirmed, and says so in error_description.
  const errorDescription = params.get("error_description") ?? "";
  const needsVerify = /confirm your email|verify your email|email (is )?not verified/i.test(errorDescription);
  const oauthFailed = !needsVerify && params.getAll("error").some((e) => e !== "read_only");
  if (needsSecondFactor) return <SecondFactor />;
  if (needsVerify) return <VerifyEmailNotice />;
  return (
    <div className="rounded-2xl border border-line bg-surface/80 p-7 shadow-pop backdrop-blur">
      <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.02em]">Welcome back</h1>
      <p className="mt-1 text-sm text-muted">Sign in to your Multies workspace.</p>
      {params.get("sso") === "required" && <p className="mt-4 rounded-lg border border-line-strong bg-elevated/60 px-3 py-2 text-sm text-muted" role="status">Your workspace requires single sign on. Continue with your company account.</p>}
      {oauthFailed && <div className="mt-4"><FormError message={params.get("error_description") || "That sign in didn't complete. Please try again."} /></div>}
      {params.get("error") === "read_only" && <div className="mt-4"><FormError message={READ_ONLY_MESSAGE} /></div>}
      {params.getAll("error").includes("account_not_linked") && <div className="mt-4" data-testid="social-not-linked"><FormError message="This email already has a Multies account, and that provider did not confirm the address. Continue with Multies and sign in with your email instead." /></div>}
      {idp && <IdentityButtons mode="signin" showDivider={password} />}
      {idp && !password && <p className="mt-4 text-center text-xs text-muted" data-testid="moved-sign-in">Forgot your password? <Link to="/forgot-password" className="font-medium text-[#0071E3] hover:underline">Set a new one</Link></p>}
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
      <h1 className="mt-4 text-[24px] font-semibold leading-tight tracking-[-0.02em]">{recovery ? "Use a backup code" : "Two-factor authentication"}</h1>
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
  if (providers.data && !providers.data.password) return <MovedSignInReset />;
  return <LocalForgotPassword />;
}

/**
 * One click reset for password accounts on the hosted sign in. Since DF-19 a password set before
 * the sign in move on 25 October 2026 works again (the identity provider checks it against the old
 * tenant once, then keeps it); this page is for anyone who forgot theirs.
 */
function MovedSignInReset() {
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get("email") ?? "");
  const send = useMutation({ mutationFn: () => api.post("/account/password-reset-link", { email }) });
  if (send.isSuccess) {
    return (
      <div className={card} data-testid="reset-sent">
        <MailCheck className="h-6 w-6 text-[#0071E3]" />
        <h1 className="mt-3 text-[24px] font-semibold leading-tight tracking-[-0.02em]">Check your email</h1>
        <p className="mt-1 text-sm text-muted">If an account with a password exists for <b className="font-medium text-fg">{email}</b>, a link to set a new password is on its way. Then sign in with Continue with Multies.</p>
        <Link to="/login" className="mt-6 block text-center text-sm font-medium text-fg hover:underline">Back to sign in</Link>
      </div>
    );
  }
  return (
    <div className={card}>
      <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.02em]">Reset your password</h1>
      <p className="mt-1 text-sm text-muted">Enter the email you sign in with and we will send a link to set a new password. Your workspace and data stay as they are.</p>
      <form className="mt-6 space-y-4" onSubmit={(e) => { e.preventDefault(); send.mutate(); }} noValidate>
        <FormError message={send.error?.message ?? null} />
        <Field label="Email">{(p) => <Input {...p} type="email" autoComplete="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />}</Field>
        <Button type="submit" className="w-full" size="lg" loading={send.isPending} disabled={!email}>Email me a reset link</Button>
      </form>
      <Link to="/login" className="mt-6 block text-center text-sm text-muted hover:text-fg">Back to sign in</Link>
    </div>
  );
}

/** Password, reset and verification steps that happen on the sign in page when the identity provider is on. */
function ManagedAtSignIn({ title, body }: { title: string; body: string }) {
  return (
    <div className={card}>
      <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.02em]">{title}</h1>
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
        <h1 className="mt-4 text-[24px] font-semibold leading-tight tracking-[-0.02em]">Check your inbox</h1>
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
      <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.02em]">Reset your password</h1>
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
        <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.02em]">This link has expired</h1>
        <p className="mt-1 text-sm text-muted">Reset links work once, for one hour.</p>
        <Link to="/forgot-password" className="mt-6 block text-center text-sm font-medium text-fg hover:underline">Request a new link</Link>
      </div>
    );
  }
  return (
    <div className={card}>
      <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.02em]">Choose a new password</h1>
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
          <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.02em]">We couldn't confirm that link</h1>
          <p className="mt-1 text-sm text-muted">It may have expired. Send a new one from Account & security.</p>
        </>
      ) : (
        <>
          <CheckCircle2 className="h-8 w-8 text-ok" />
          <h1 className="mt-3 text-[24px] font-semibold leading-tight tracking-[-0.02em]">Email confirmed</h1>
          <p className="mt-1 text-sm text-muted">Your address is verified.</p>
        </>
      )}
      <Link to={HOME} className="mt-6 block text-center text-sm font-medium text-fg hover:underline">Open Multies</Link>
    </div>
  );
}

export function SignupPage() {
  const providers = useAuthProviders();
  const [params] = useSearchParams();
  if (providers.data?.idp && !providers.data.password) {
    return (
      <div className={card}>
        <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.02em]">Create your account</h1>
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
    // This form is the onboarding for email and password accounts: the browser fills in the zone, language and country.
    const zone = browserTimeZone() ?? "UTC";
    const locale = cleanLocale(navigator.language) ?? "en";
    await api.post("/account/onboarding", {
      name: b.name, timezone: zone, locale, workspaceTimezone: zone,
      company: b.organization.trim() || undefined, country: guessCountry(locale, zone) ?? undefined,
    }).catch(() => undefined);
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
      <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.02em]">Create your account</h1>
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
