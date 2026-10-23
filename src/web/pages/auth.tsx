import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Sparkles } from "lucide-react";
import { Button } from "@/web/components/ui/button";
import { Field, Input } from "@/web/components/ui/input";
import { api, ApiError } from "@/web/lib/api";
import { useConfig } from "@/web/lib/queries";
import { useStartDemo } from "@/web/lib/demo";

function useAuthSubmit(path: "/auth/login" | "/auth/signup") {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const submit = async (body: Record<string, string>) => {
    setLoading(true);
    setError(null);
    setFields({});
    try {
      await api.post(path, body);
      qc.clear();
      const next = params.get("next");
      navigate(next && next.startsWith("/app") ? next : "/app");
    } catch (err) {
      if (err instanceof ApiError && err.fields) setFields(err.fields);
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };
  return { submit, loading, error, fields };
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
  const { submit, loading, error, fields } = useAuthSubmit("/auth/login");
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    submit({ email: String(f.get("email")), password: String(f.get("password")) });
  };
  return (
    <div className="rounded-2xl border border-line bg-surface/80 p-7 shadow-pop backdrop-blur">
      <h1 className="text-xl font-semibold tracking-tight">Welcome back</h1>
      <p className="mt-1 text-sm text-muted">Sign in to your MyMail workspace.</p>
      <form className="mt-6 space-y-4" onSubmit={onSubmit} noValidate>
        <FormError message={error} />
        <Field label="Email" error={fields.email}>{(p) => <Input {...p} name="email" type="email" autoComplete="email" placeholder="you@company.com" required autoFocus />}</Field>
        <Field label="Password" error={fields.password}>{(p) => <PasswordInput {...p} name="password" autoComplete="current-password" required />}</Field>
        <Button type="submit" className="w-full" size="lg" loading={loading}>Sign in</Button>
      </form>
      <DemoLink />
      <p className="mt-6 text-center text-sm text-muted">New to MyMail? <Link to="/signup" className="font-medium text-fg hover:underline">Create an account</Link></p>
    </div>
  );
}

export function SignupPage() {
  const { submit, loading, error, fields } = useAuthSubmit("/auth/signup");
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
        <Field label="Work email" error={fields.email}>{(p) => <Input {...p} name="email" type="email" autoComplete="email" placeholder="ada@company.com" required />}</Field>
        <Field label="Password" error={fields.password} hint="At least 10 characters.">{(p) => <PasswordInput {...p} name="password" autoComplete="new-password" required minLength={10} />}</Field>
        <Field label="Company" hint="Optional — names your workspace." error={fields.organization}>{(p) => <Input {...p} name="organization" autoComplete="organization" placeholder="Analytical Engines Ltd." />}</Field>
        <Button type="submit" className="w-full" size="lg" loading={loading}>Create account</Button>
      </form>
      <DemoLink />
      <p className="mt-6 text-center text-sm text-muted">Already have an account? <Link to="/login" className="font-medium text-fg hover:underline">Sign in</Link></p>
    </div>
  );
}
