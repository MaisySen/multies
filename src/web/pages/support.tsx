import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { LifeBuoy, Mail, Smartphone, Trash2 } from "lucide-react";
import { useConfig, useMe } from "@/web/lib/queries";
import { api, ApiError } from "@/web/lib/api";
import { Button } from "@/web/components/ui/button";

const card = "rounded-xl border border-line bg-fill/60 p-5";

function SupportEmail() {
  const config = useConfig();
  const email = config.data?.supportEmail ?? "support@mymail.au";
  return <a href={`mailto:${email}`} className="font-medium text-accent hover:underline">{email}</a>;
}

/** Public support page: the support URL given to the App Store and Google Play. */
export function SupportPage() {
  useEffect(() => { document.title = "Support | MyMail"; }, []);
  return (
    <article className="mx-auto max-w-3xl px-5 pb-24 pt-28">
      <p className="text-xs uppercase tracking-wide text-subtle">Help</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Support</h1>
      <p className="mt-2 text-muted">Questions about MyMail on the web or the phone app, your account or your mail. A person reads every message.</p>
      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <section className={card} aria-labelledby="s-mail">
          <Mail className="h-5 w-5 text-accent" aria-hidden />
          <h2 id="s-mail" className="mt-3 font-semibold">Email us</h2>
          <p className="mt-1.5 text-[14px] text-muted">Write to <SupportEmail />. Tell us the email address you sign in with and what you were doing. We aim to reply within two business days (Sydney time).</p>
        </section>
        <section className={card} aria-labelledby="s-status">
          <LifeBuoy className="h-5 w-5 text-accent" aria-hidden />
          <h2 id="s-status" className="mt-3 font-semibold">Is something down?</h2>
          <p className="mt-1.5 text-[14px] text-muted">The <Link to="/status" className="text-accent hover:underline">status page</Link> shows live checks of sign in, the API and mail delivery.</p>
        </section>
        <section className={card} aria-labelledby="s-app">
          <Smartphone className="h-5 w-5 text-accent" aria-hidden />
          <h2 id="s-app" className="mt-3 font-semibold">The phone app</h2>
          <p className="mt-1.5 text-[14px] text-muted">Sign in with your MyMail email and password, or tap Explore with sample data to look around first. The app is free and has no purchases.</p>
        </section>
        <section className={card} aria-labelledby="s-delete">
          <Trash2 className="h-5 w-5 text-accent" aria-hidden />
          <h2 id="s-delete" className="mt-3 font-semibold">Delete your account</h2>
          <p className="mt-1.5 text-[14px] text-muted">In the app: Settings, then Delete my account. On the web: <Link to="/delete-account" className="text-accent hover:underline">delete your account here</Link>.</p>
        </section>
      </div>
      <p className="mt-10 text-sm text-subtle">
        See also <Link to="/privacy" className="hover:text-fg hover:underline">Privacy</Link> and <Link to="/terms" className="hover:text-fg hover:underline">Terms</Link>.
      </p>
    </article>
  );
}

/** Public account deletion page: the deletion URL given to Google Play and Apple. */
export function DeleteAccountPage() {
  useEffect(() => { document.title = "Delete your account | MyMail"; }, []);
  const me = useMe();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.del("/account", { confirm, password: password || undefined });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Your account could not be deleted. Try again, or email support.");
    } finally {
      setBusy(false);
    }
  }

  const signedIn = me.isSuccess && !!me.data?.user;
  return (
    <article className="mx-auto max-w-2xl px-5 pb-24 pt-28">
      <p className="text-xs uppercase tracking-wide text-subtle">Account</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Delete your MyMail account</h1>
      <p className="mt-2 text-muted">You can delete your account at any time, for free. It cannot be undone.</p>

      <section aria-labelledby="d-what" className="mt-8">
        <h2 id="d-what" className="text-lg font-semibold">What is deleted</h2>
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[14.5px] text-muted">
          <li>Your profile, sign in details, sessions, two-step codes and phone app registrations.</li>
          <li>Every workspace where you are the only member, with its mail, mailboxes, domains, tasks, docs, contacts and files.</li>
          <li>In a workspace you share with others, your membership. The workspace and what others wrote stay with them.</li>
        </ul>
        <p className="mt-3 text-[14.5px] text-muted">Deletion is immediate. Encrypted backups that still hold the data expire within 30 days. Mail you already sent to other people stays in their inboxes. If you are the only owner of a shared workspace, make someone else an owner first.</p>
      </section>

      <section aria-labelledby="d-how" className="mt-8">
        <h2 id="d-how" className="text-lg font-semibold">How to delete it</h2>
        <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[14.5px] text-muted">
          <li>In the phone app: Settings, then Delete my account.</li>
          <li>On the web: sign in, then use the form below (or Settings, Account, Delete account).</li>
          <li>Or email <SupportEmail /> from the address you sign in with, and we delete it for you within 7 days.</li>
        </ol>
      </section>

      <section aria-labelledby="d-form" className={`${card} mt-8`}>
        <h2 id="d-form" className="font-semibold">Delete my account now</h2>
        {done ? (
          <div role="status" className="mt-3 text-[14.5px] text-muted">
            <p>Your account is deleted. A confirmation email is on its way.</p>
            <Button className="mt-4" variant="secondary" onClick={() => navigate("/")}>Back to the home page</Button>
          </div>
        ) : !signedIn ? (
          <p className="mt-2 text-[14.5px] text-muted">
            <Link to="/login?next=/delete-account" className="text-accent hover:underline">Sign in</Link> first, then come back to this page.
          </p>
        ) : (
          <form onSubmit={submit} className="mt-3 space-y-4" noValidate>
            <p className="text-[14.5px] text-muted">Signed in as <span className="text-fg">{me.data?.user.email}</span>.</p>
            <div>
              <label htmlFor="d-confirm" className="block text-sm font-medium">Type DELETE to confirm</label>
              <input id="d-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" autoCapitalize="characters"
                className="mt-1.5 w-full rounded-lg border border-line bg-transparent px-3 py-2 text-sm" />
            </div>
            <div>
              <label htmlFor="d-password" className="block text-sm font-medium">Password</label>
              <input id="d-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password"
                className="mt-1.5 w-full rounded-lg border border-line bg-transparent px-3 py-2 text-sm" />
              <p className="mt-1 text-xs text-subtle">Leave it empty if you sign in with Google, GitHub or single sign on.</p>
            </div>
            {error && <p role="alert" className="text-sm text-bad">{error}</p>}
            <Button type="submit" variant="danger" disabled={busy || confirm !== "DELETE"}>{busy ? "Deleting..." : "Delete my account"}</Button>
          </form>
        )}
      </section>
    </article>
  );
}
