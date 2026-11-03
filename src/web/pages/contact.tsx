import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { IconMail, IconSend } from "@/web/components/ui/icon";
import { api, ApiError } from "@/web/lib/api";
import { LEGAL_ENTITY } from "@/shared/legal-entity";
import { Button } from "@/web/components/ui/button";
import { Field, Input, Textarea } from "@/web/components/ui/input";

type Fields = Partial<Record<"name" | "email" | "message", string>>;

/** Checks in the browser first, so mistakes show next to the field before anything is sent. */
function check(v: { name: string; email: string; message: string }): Fields {
  const f: Fields = {};
  if (!v.name.trim()) f.name = "Enter your name.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())) f.email = "Enter a valid email address.";
  if (v.message.trim().length < 10) f.message = "Tell us a little more (at least 10 characters).";
  return f;
}

/** Public contact form. Sends to the support address; the thank-you page follows. */
export function ContactUsPage() {
  const navigate = useNavigate();
  // WEB1: one public address everywhere, the same before and after the page loads.
  const email = LEGAL_ENTITY.contactEmail;
  const [fields, setFields] = useState<Fields>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const v = {
      name: String(data.get("name") ?? ""), email: String(data.get("email") ?? ""), company: String(data.get("company") ?? ""),
      message: String(data.get("message") ?? ""), website: String(data.get("website") ?? ""),
    };
    setError(null);
    const local = check(v);
    setFields(local);
    if (Object.keys(local).length) {
      e.currentTarget.querySelector<HTMLElement>("[aria-invalid=true]")?.focus();
      return;
    }
    setBusy(true);
    try {
      await api.post("/contact", { ...v, company: v.company || undefined, website: v.website || undefined });
      navigate("/thank-you");
    } catch (err) {
      if (err instanceof ApiError && err.fields) setFields(err.fields as Fields);
      setError(err instanceof Error ? err.message : `Your message couldn't be sent. Email ${email} instead.`);
      setBusy(false);
    }
  }

  return (
    <article className="mx-auto max-w-xl px-5 pb-24 pt-28">
      <p className="text-xs uppercase tracking-wide text-subtle">Contact</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Talk to us</h1>
      <p className="mt-2 text-muted">Questions, a demo for your team, or help moving your mail. A person reads every message and replies within one business day (Sydney time).</p>
      <form onSubmit={submit} className="mt-8 space-y-4 rounded-2xl border border-line bg-surface p-5 sm:p-6" noValidate data-testid="contact-form">
        {error && <div role="alert" className="rounded-lg border border-bad/25 bg-bad-soft px-3 py-2.5 text-sm text-bad" data-testid="contact-error">{error}</div>}
        <Field label="Your name" error={fields.name}>{(p) => <Input {...p} name="name" autoComplete="name" required maxLength={100} />}</Field>
        <Field label="Email" error={fields.email}>{(p) => <Input {...p} name="email" type="email" autoComplete="email" inputMode="email" placeholder="you@company.com" required maxLength={254} />}</Field>
        <Field label="Company" hint="Optional.">{(p) => <Input {...p} name="company" autoComplete="organization" maxLength={120} />}</Field>
        <Field label="Message" error={fields.message}>{(p) => <Textarea {...p} name="message" rows={6} required maxLength={5000} />}</Field>
        <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
          <label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
        </div>
        <Button type="submit" size="lg" className="w-full" loading={busy} data-testid="contact-submit">
          {!busy && <IconSend className="h-4 w-4" aria-hidden />}{busy ? "Sending" : "Send message"}
        </Button>
        <p className="text-xs text-subtle">We use your details only to reply. See our <Link to="/privacy" className="underline underline-offset-2 hover:text-fg">privacy policy</Link>.</p>
      </form>
      <p className="mt-6 flex items-center gap-2 text-sm text-muted"><IconMail className="h-4 w-4 text-accent" aria-hidden />Prefer email? Write to <a href={`mailto:${email}`} className="font-medium text-accent hover:underline">{email}</a>.</p>
    </article>
  );
}
