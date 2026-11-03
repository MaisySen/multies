import { useEffect, useState, type FormEvent } from "react";
import { READ_ONLY_MESSAGE } from "@/web/lib/read-only";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { IconCheckCircle, IconChevronDown, IconEye, IconEyeOff, IconKey, IconMailCheck, IconPlay, IconShieldCheck } from "@/web/components/ui/icon";
import { toast } from "sonner";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/web/components/ui/button";
import { Field, Input } from "@/web/components/ui/input";
import { api, ApiError } from "@/web/lib/api";
import { authClient, unwrap } from "@/web/lib/auth-client";
import { useConfig } from "@/web/lib/queries";
import { authProvidersQuery } from "@/web/lib/auth-providers";
import { useStartDemo } from "@/web/lib/demo";
import { DemoPausedNote } from "@/web/components/demo-paused";
import { SocialSignInButtons } from "@/web/components/social-sign-in";
import { GitHubLogo, GoogleSignInButton, ProviderButton } from "@/web/components/google-button";
import { browserTimeZone } from "@/web/lib/format";
import { cleanLocale, guessCountry } from "@/shared/locale";
import { signInDestination } from "@/web/lib/pending-invite";
import { passkeyMessage, passkeysSupported, signInWithPasskey, wasCancelled } from "@/web/lib/passkeys-des1";
import { tr } from "@/web/i18n"; // R104

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
      const dest = signInDestination(params.get("next"), HOME);
      // R40 (MB-218): straight into the app after sign up (no /thanks stop), with a one time welcome toast.
      navigate(dest);
      if (opts.thanks) toast.success(tr("auth.welcome_to_multies"), { id: "welcome", description: "Your workspace is ready. We sent a link to confirm your email address.", duration: 6000 });
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
  // R41 (MB-221): with no next, a remembered invite is where sign in lands (it survives the confirmation email).
  return signInDestination(next, HOME);
}

/** Sends the browser to the identity provider's sign in (or sign up) page; it comes back to `next` or a remembered invite. */
export async function startIdentitySignIn(which: "signin" | "signup", opts: { next?: string | null; email?: string | null } = {}) {
  await unwrap(authClient.signIn.social({
    provider: "auth0", callbackURL: safeNext(opts.next ?? null), errorCallbackURL: "/login?error=oauth",
    ...(opts.email ? { loginHint: opts.email } : {}),
    ...(which === "signup" ? { additionalParams: { screen_hint: "signup" } } : {}),
  }));
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
    try { await startIdentitySignIn(which, { next: params.get("next"), email: params.get("email") }); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Sign in failed"); setBusy(null); }
  };
  const primary = mode === "signup" ? "signup" : "signin";
  const secondary = primary === "signin" ? "signup" : "signin";
  // R40 (MB-213): the sign up heading already says "Create your account"; the button says what it does.
  const label = { signin: tr("auth.continue_with_multies"), signup: tr("auth.sign_up_with_email") };
  return (
    <div className="mt-6 space-y-2">
      <Button className="w-full" size="lg" loading={busy === primary} onClick={() => go(primary)} data-testid="idp-primary">{label[primary]}</Button>
      <Button variant="secondary" className="w-full" loading={busy === secondary} onClick={() => go(secondary)} data-testid="idp-secondary">{secondary === "signup" ? "Create account" : "Sign in instead"}</Button>
      {/* Round 25: Google and Microsoft straight through the identity provider, when this deployment turns them on.
          R40 (MB-213): on sign up they fold under "Other ways to sign up", so the page leads with one path. */}
      {mode === "signup" ? (
        <details className="group pt-2" data-testid="other-signup">
          <summary className="flex min-h-10 cursor-pointer list-none items-center justify-center gap-1.5 rounded-lg text-[13px] font-medium text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
            {tr("auth.other_ways_to_sign_up")}<IconChevronDown className="h-4 w-4 transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none" aria-hidden />
          </summary>
          <div className="space-y-2 pt-2">
            <SocialSignInButtons callbackURL={safeNext(params.get("next"))} loginHint={params.get("email") ?? undefined} />
            <p className="pt-1 text-center text-xs text-subtle">{tr("auth.use_your_email_a_one_time_code_a_passkey_or_your")}</p>
          </div>
        </details>
      ) : <>
        <div className="pt-2"><SocialSignInButtons callbackURL={safeNext(params.get("next"))} loginHint={params.get("email") ?? undefined} /></div>
        <p className="pt-1 text-center text-xs text-subtle">{tr("auth.use_your_email_a_one_time_code_a_passkey_or_your")}</p>
      </>}
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
          : <ProviderButton key={p} logo={<GitHubLogo />} loading={busy === p} disabled={!!busy && busy !== p} onClick={() => go(p)} data-testid={`social-${p}`}>{tr("auth.continue_with", { name: label[p] })}</ProviderButton>
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
      <button type="button" onClick={() => setShow((s) => !s)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-subtle hover:text-fg max-sm:after:absolute max-sm:after:-inset-2.5 max-sm:after:content-['']" aria-label={show ? "Hide password" : "Show password"}>
        {show ? <IconEyeOff className="h-4 w-4" /> : <IconEye className="h-4 w-4" />}
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
      <div className="my-6 flex items-center gap-3 text-xs text-subtle"><span className="h-px flex-1 bg-line" />{tr("common.or")}<span className="h-px flex-1 bg-line" /></div>
      <Button variant="secondary" className="w-full" onClick={demo.start} loading={demo.loading}><IconPlay className="h-4 w-4" /> {tr("auth.explore_a_demo_workspace")}</Button>
      {demo.paused && <DemoPausedNote />}
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
      <div className="grid h-11 w-11 place-items-center rounded-full bg-brand/10 text-accent" aria-hidden><IconMailCheck className="h-5 w-5" /></div>
      <h1 className="mt-4 text-[24px] font-semibold leading-tight tracking-[-0.02em]">{tr("auth.check_your_email_to_verify_your_account")}</h1>
      <p className="mt-2 text-sm text-muted">{tr("auth.your_account_is_created_we_sent_a_confirmation_l")}</p>
      <form className="mt-6 space-y-3" onSubmit={onSubmit} noValidate>
        {resend.isSuccess && <p role="status" className="rounded-lg border border-ok/25 bg-ok-soft px-3 py-2.5 text-sm text-ok">{tr("auth.if_that_address_is_waiting_for_confirmation_a_ne")}</p>}
        {resend.error && !serverFields && <FormError message={resend.error.message} />}
        <Field label={tr("auth.didn_t_get_it_send_the_link_again")} error={fieldError ?? serverFields?.email}>{(p) => <Input {...p} name="email" type="email" autoComplete="email" inputMode="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Button type="submit" variant="secondary" className="w-full" loading={resend.isPending} data-testid="resend-verification">{resend.isPending ? "Sending" : "Resend link"}</Button>
      </form>
      <Link to="/login" replace className="mt-4 block text-center text-sm font-medium text-accent hover:underline">{tr("auth.i_ve_confirmed_it_sign_in")}</Link>
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
  const oauthFailed = !needsVerify && params.getAll("error").some((e) => e !== "read_only" && e !== "account_not_linked");
  // R41 (MB-223): arriving from the provider's "Email confirmed" page (its Back to Multies button opens
  // /login?confirmed=1), sign in starts on its own, once per tab, and lands on a remembered invite.
  const confirmed = params.get("confirmed") === "1" && idp && !oauthFailed;
  const [autoStarted, setAutoStarted] = useState(false);
  useEffect(() => {
    if (!confirmed || autoStarted) return;
    if (sessionStorage.getItem("multies.confirmedSignIn") === "1") return;
    sessionStorage.setItem("multies.confirmedSignIn", "1");
    setAutoStarted(true);
    void startIdentitySignIn("signin", { next: params.get("next") }).catch(() => setAutoStarted(false));
  }, [confirmed, autoStarted, params]);
  if (needsSecondFactor) return <SecondFactor />;
  if (needsVerify) return <VerifyEmailNotice />;
  return (
    <div className="rounded-2xl border border-line bg-surface/80 p-7 shadow-pop backdrop-blur">
      <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.02em]">{tr("auth.welcome_back")}</h1>
      <p className="mt-1 text-sm text-muted">{tr("auth.sign_in_to_your_multies_workspace")}</p>
      {params.get("sso") === "required" && <p className="mt-4 rounded-lg border border-line-strong bg-elevated/60 px-3 py-2 text-sm text-muted" role="status">{tr("auth.your_workspace_requires_single_sign_on_continue")}</p>}
      {confirmed && !oauthFailed && <p role="status" className="mt-4 flex items-center gap-2 rounded-lg border border-ok/25 bg-ok-soft px-3 py-2 text-sm text-fg" data-testid="confirmed-signing-in"><IconCheckCircle className="h-4 w-4 shrink-0 text-ok" aria-hidden />{tr("auth.email_confirmed_signing_you_in")}</p>}
      {/* R41 (MB-222): every failed sign in lands here with a plain message and one way forward, never raw text. */}
      {oauthFailed && <SignInFailed idp={idp} />}
      {params.get("error") === "read_only" && <div className="mt-4"><FormError message={READ_ONLY_MESSAGE} /></div>}
      {params.getAll("error").includes("account_not_linked") && <div className="mt-4" data-testid="social-not-linked"><FormError message={tr("auth.this_email_already_has_a_multies_account_and_tha")} /></div>}
      {idp && <IdentityButtons mode="signin" showDivider={password} />}
      {idp && !password && <p className="mt-4 text-center text-xs text-muted" data-testid="moved-sign-in">{tr("auth.forgot_your_password")} <Link to="/forgot-password" className="font-medium text-brand-hover hover:underline">{tr("auth.set_a_new_one")}</Link></p>}
      {!idp && <SocialButtons />}
      <PasskeySignIn />
      {password && (
        <form className="mt-6 space-y-4" onSubmit={onSubmit} noValidate>
          <FormError message={error} />
          <Field label={tr("common.email")} error={fields.email}>{(p) => <Input {...p} name="email" type="email" autoComplete="email" placeholder="you@company.com" required autoFocus={!idp && !params.get("email")} defaultValue={params.get("email") ?? ""} />}</Field>
          <div className="space-y-1.5">
            <Field label={tr("common.password")} error={fields.password}>{(p) => <PasswordInput {...p} name="password" autoComplete="current-password" required autoFocus={!idp && !!params.get("email")} />}</Field>
            <div className="text-right"><Link to="/forgot-password" className="text-xs text-muted hover:text-fg hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center">{tr("auth.forgot_password")}</Link></div>
          </div>
          <Button type="submit" className="w-full" size="lg" variant={idp ? "secondary" : undefined} loading={loading}>{tr("common.sign_in")}</Button>
        </form>
      )}
      <DemoLink />
      {!idp && <p className="mt-6 text-center text-sm text-muted">{tr("auth.new_to_multies")} <Link to={`/signup${params.get("next") ? `?next=${encodeURIComponent(params.get("next")!)}` : ""}`} className="font-medium text-fg hover:underline">{tr("auth.create_an_account")}</Link></p>}
    </div>
  );
}

/** DES1 (PASSKEY_DES1): one tap sign in with Face ID, a fingerprint or the device PIN. A closed prompt stays quiet. */
function PasskeySignIn() {
  const config = useConfig();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!config.data?.passkeyDes1 || !passkeysSupported()) return null;
  const go = async () => {
    setBusy(true); setError(null);
    try {
      await signInWithPasskey();
      qc.clear();
      navigate(signInDestination(params.get("next"), HOME));
    } catch (err) {
      if (!wasCancelled(err)) setError(passkeyMessage(err, "That passkey did not work here. Sign in another way, then add it again in Account and security."));
    } finally { setBusy(false); }
  };
  return (
    <div className="mt-6 space-y-2" data-testid="passkey-sign-in">
      <Button type="button" variant="secondary" size="lg" className="w-full" loading={busy} onClick={() => void go()}><IconKey className="h-4 w-4" aria-hidden />{tr("auth.sign_in_with_a_passkey")}</Button>
      {error && <FormError message={error} />}
    </div>
  );
}

/** R41 (MB-222): the plain "couldn't finish signing you in" notice with a Try again button. */
function SignInFailed({ idp }: { idp: boolean }) {
  const [params] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const reason = params.get("error");
  const text = reason === "verify" ? "We couldn't confirm that link. It may have expired. Sign in and we'll send a new one."
    : reason === "server" ? "We couldn't finish signing you in because Multies was busy. Try again."
    : "We couldn't finish signing you in. Try again.";
  const retry = async () => {
    setBusy(true);
    if (!idp) { window.location.assign(`/login${params.get("next") ? `?next=${encodeURIComponent(params.get("next")!)}` : ""}`); return; }
    try { await startIdentitySignIn("signin", { next: params.get("next"), email: params.get("email") }); } catch { setBusy(false); }
  };
  return (
    <div role="alert" data-testid="signin-failed" className="mt-4 rounded-xl border border-bad/25 bg-bad-soft px-3.5 py-3 text-sm text-bad">
      <p>{text}</p>
      <Button size="sm" variant="secondary" className="mt-2.5" loading={busy} onClick={retry} data-testid="signin-try-again">{tr("common.try_again")}</Button>
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
      <div className="grid h-11 w-11 place-items-center rounded-xl border border-line-strong bg-elevated text-brand-hover">{recovery ? <IconKey className="h-5 w-5" /> : <IconShieldCheck className="h-5 w-5" />}</div>
      <h1 className="mt-4 text-[24px] font-semibold leading-tight tracking-[-0.02em]">{recovery ? "Use a backup code" : "Two-factor authentication"}</h1>
      <p className="mt-1 text-sm text-muted">{recovery ? "Enter one of the backup codes you saved when you turned on two-factor." : "Enter the 6-digit code from your authenticator app."}</p>
      <form className="mt-6 space-y-4" onSubmit={(e) => { e.preventDefault(); submit({ code }); }} noValidate>
        <FormError message={error && !fields.code ? error : null} />
        <Field label={recovery ? "Backup code" : "Code"} error={fields.code}>
          {(p) => <Input {...p} key={String(recovery)} value={code} onChange={(e) => setCode(e.target.value)} autoFocus
            {...(recovery ? { placeholder: "xxxxx-xxxxx", autoComplete: "off" } : { inputMode: "numeric", autoComplete: "one-time-code", placeholder: "123456", maxLength: 7 })}
            className="font-mono tracking-widest" />}
        </Field>
        <Button type="submit" className="w-full" size="lg" loading={loading} disabled={!code.trim()}>{tr("auth.verify")}</Button>
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
        <IconMailCheck className="h-6 w-6 text-brand-hover" />
        <h1 className="mt-3 text-[24px] font-semibold leading-tight tracking-[-0.02em]">{tr("auth.check_your_email")}</h1>
        <p className="mt-1 text-sm text-muted">If an account with a password exists for <b className="font-medium text-fg">{email}</b>, a link to set a new password is on its way. Then sign in with Continue with Multies.</p>
        <Link to="/login" className="mt-6 flex min-h-11 items-center justify-center text-sm font-medium text-fg hover:underline">{tr("auth.back_to_sign_in")}</Link>
      </div>
    );
  }
  return (
    <div className={card}>
      <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.02em]">{tr("auth.reset_your_password")}</h1>
      <p className="mt-1 text-sm text-muted">{tr("auth.enter_the_email_you_sign_in_with_and_we_will_sen")}</p>
      <form className="mt-6 space-y-4" onSubmit={(e) => { e.preventDefault(); send.mutate(); }} noValidate>
        <FormError message={send.error?.message ?? null} />
        <Field label={tr("common.email")}>{(p) => <Input {...p} type="email" autoComplete="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />}</Field>
        <Button type="submit" className="w-full" size="lg" loading={send.isPending} disabled={!email}>{tr("auth.email_me_a_reset_link")}</Button>
      </form>
      <Link to="/login" className="mt-6 flex min-h-11 items-center justify-center text-sm text-muted hover:text-fg">{tr("auth.back_to_sign_in")}</Link>
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
      <Link to="/login" className="mt-6 flex min-h-11 items-center justify-center text-sm text-muted hover:text-fg">{tr("auth.back_to_sign_in")}</Link>
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
        <div className="grid h-11 w-11 place-items-center rounded-xl border border-line-strong bg-elevated text-brand-hover"><IconMailCheck className="h-5 w-5" /></div>
        <h1 className="mt-4 text-[24px] font-semibold leading-tight tracking-[-0.02em]">{tr("auth.check_your_inbox")}</h1>
        <p className="mt-1 text-sm text-muted">If an account exists for <b className="font-medium text-fg">{email}</b>, a reset link is on its way. It works for one hour.</p>
        {!deliveryConnected && (
          <p className="mt-4 rounded-lg border border-warn/25 bg-warn-soft px-3 py-2 text-sm text-warn">{tr("auth.email_delivery_isn_t_connected_on_this_deploymen")}</p>
        )}
        <Link to="/login" className="mt-6 flex min-h-11 items-center justify-center text-sm font-medium text-fg hover:underline">{tr("auth.back_to_sign_in")}</Link>
      </div>
    );
  }
  return (
    <div className={card}>
      <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.02em]">{tr("auth.reset_your_password")}</h1>
      <p className="mt-1 text-sm text-muted">{tr("auth.we_ll_email_you_a_link_to_choose_a_new_one")}</p>
      <form className="mt-6 space-y-4" onSubmit={(e) => { e.preventDefault(); send.mutate(); }} noValidate>
        <FormError message={send.error?.message ?? null} />
        <Field label={tr("common.email")}>{(p) => <Input {...p} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoFocus />}</Field>
        <Button type="submit" className="w-full" size="lg" loading={send.isPending} disabled={!email}>{tr("auth.send_reset_link")}</Button>
      </form>
      {config.data?.outboundDriver === "log" && <p className="mt-4 text-xs text-subtle">{tr("auth.heads_up_email_delivery_isn_t_connected_on_this")}</p>}
      <Link to="/login" className="mt-6 flex min-h-11 items-center justify-center text-sm text-muted hover:text-fg">{tr("auth.back_to_sign_in")}</Link>
    </div>
  );
}

export function ResetPasswordPage() {
  const providers = useAuthProviders();
  if (providers.data && !providers.data.password) return <ManagedAtSignIn title={tr("auth.reset_your_password")} body={tr("auth.password_resets_happen_on_the_sign_in_page_now_c")} />;
  return <LocalResetPassword />;
}

function LocalResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const reset = useMutation({
    mutationFn: () => unwrap(authClient.resetPassword({ token, newPassword: password })),
    onSuccess: () => { toast.success(tr("auth.password_updated"), { description: "Sign in with your new password." }); navigate("/login"); },
  });
  if (!token || params.get("error")) {
    return (
      <div className={card}>
        <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.02em]">{tr("auth.this_link_has_expired")}</h1>
        <p className="mt-1 text-sm text-muted">{tr("auth.reset_links_work_once_for_one_hour")}</p>
        <Link to="/forgot-password" className="mt-6 block text-center text-sm font-medium text-fg hover:underline">{tr("auth.request_a_new_link")}</Link>
      </div>
    );
  }
  return (
    <div className={card}>
      <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.02em]">{tr("auth.choose_a_new_password")}</h1>
      <p className="mt-1 text-sm text-muted">{tr("auth.you_ll_be_signed_out_on_every_device")}</p>
      <form className="mt-6 space-y-4" onSubmit={(e) => { e.preventDefault(); reset.mutate(); }} noValidate>
        <FormError message={reset.error?.message ?? null} />
        <Field label={tr("auth.new_password")} hint={tr("auth.at_least_10_characters")}>{(p) => <PasswordInput {...p} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />}</Field>
        <Button type="submit" className="w-full" size="lg" loading={reset.isPending} disabled={password.length < 10}>{tr("auth.update_password")}</Button>
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
          <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.02em]">{tr("auth.we_couldn_t_confirm_that_link")}</h1>
          <p className="mt-1 text-sm text-muted">{tr("auth.it_may_have_expired_send_a_new_one_from_account")}</p>
        </>
      ) : (
        <>
          <IconCheckCircle className="h-8 w-8 text-ok" />
          <h1 className="mt-3 text-[24px] font-semibold leading-tight tracking-[-0.02em]">{tr("auth.email_confirmed")}</h1>
          <p className="mt-1 text-sm text-muted">{tr("auth.your_address_is_verified")}</p>
        </>
      )}
      <Link to={HOME} className="mt-6 block text-center text-sm font-medium text-fg hover:underline">{tr("auth.open_multies")}</Link>
    </div>
  );
}

export function SignupPage() {
  const providers = useAuthProviders();
  const [params] = useSearchParams();
  if (providers.data?.idp && !providers.data.password) {
    return (
      <div className={card}>
        <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.02em]">{tr("auth.create_your_account")}</h1>
        <p className="mt-1 text-sm text-muted">{tr("auth.free_for_startups_and_small_teams_no_credit_card")}</p>
        <IdentityButtons mode="signup" showDivider={false} />
        <p className="mt-4 text-center text-xs text-subtle">
          By creating an account you agree to the <Link to="/terms" className="underline hover:text-fg">{tr("auth.terms")}</Link>, <Link to="/acceptable-use" className="underline hover:text-fg">{tr("auth.acceptable_use_policy")}</Link> and <Link to="/privacy" className="underline hover:text-fg">{tr("auth.privacy_policy")}</Link>.
        </p>
        <DemoLink />
        <p className="mt-6 text-center text-sm text-muted">{tr("auth.already_have_an_account")} <Link to={`/login${params.get("next") ? `?next=${encodeURIComponent(params.get("next")!)}` : ""}`} className="font-medium text-fg hover:underline">{tr("common.sign_in")}</Link></p>
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
      <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.02em]">{tr("auth.create_your_account")}</h1>
      <p className="mt-1 text-sm text-muted">{tr("auth.free_for_your_first_domain_no_credit_card")}</p>
      {idp && <IdentityButtons mode="signup" showDivider />}
      <form className="mt-6 space-y-4" onSubmit={onSubmit} noValidate>
        <FormError message={error && !Object.keys(fields).length ? error : null} />
        <Field label={tr("auth.your_name")} error={fields.name}>{(p) => <Input {...p} name="name" autoComplete="name" placeholder="Ada Lovelace" required autoFocus />}</Field>
        <Field label={tr("auth.work_email")} error={fields.email}>{(p) => <Input {...p} name="email" type="email" autoComplete="email" placeholder="ada@company.com" required defaultValue={params.get("email") ?? ""} readOnly={!!params.get("invited")} />}</Field>
        <Field label={tr("common.password")} error={fields.password} hint={tr("auth.at_least_10_characters")}>{(p) => <PasswordInput {...p} name="password" autoComplete="new-password" required minLength={10} />}</Field>
        {!params.get("invited") && <Field label={tr("auth.company")} hint={tr("auth.optional_names_your_workspace")} error={fields.organization}>{(p) => <Input {...p} name="organization" autoComplete="organization" placeholder="Analytical Engines Ltd." />}</Field>}
        <Button type="submit" className="w-full" size="lg" loading={loading}>{tr("auth.create_account")}</Button>
        <p className="text-center text-xs text-subtle">
          By creating an account you agree to the <Link to="/terms" className="underline hover:text-fg">{tr("auth.terms")}</Link>, <Link to="/acceptable-use" className="underline hover:text-fg">{tr("auth.acceptable_use_policy")}</Link> and <Link to="/privacy" className="underline hover:text-fg">{tr("auth.privacy_policy")}</Link>.
        </p>
      </form>
      <DemoLink />
      <p className="mt-6 text-center text-sm text-muted">{tr("auth.already_have_an_account")} <Link to={`/login${params.get("next") ? `?next=${encodeURIComponent(params.get("next")!)}` : ""}`} className="font-medium text-fg hover:underline">{tr("common.sign_in")}</Link></p>
    </div>
  );
}
