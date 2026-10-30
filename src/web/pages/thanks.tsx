import { useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { IconCheckCircle } from "@/web/components/ui/icon";
import { Logo } from "@/web/components/logo";
import { ButtonLink } from "@/web/components/ui/button";

const COPY: Record<string, { title: string; body: string }> = {
  signup: { title: "Thanks for signing up", body: "Your workspace is ready. We sent a link to confirm your email address. Taking you to your dashboard now." },
  contact: { title: "Thanks, we got your message", body: "We reply to every message, usually within one business day (Sydney time)." },
};

/** The thank-you page after sign-up and after a contact form. */
export function ThanksPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const from = params.get("from") ?? "contact";
  const raw = params.get("next") ?? "";
  const next = raw.startsWith("/app") || raw.startsWith("/invite/") ? raw : from === "signup" ? "/app" : "/";
  const copy = COPY[from] ?? COPY.contact;
  useEffect(() => {
    if (from !== "signup") return;
    const t = setTimeout(() => navigate(next, { replace: true }), 2500);
    return () => clearTimeout(t);
  }, [from, next, navigate]);
  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-6 py-16">
      <div className="w-full max-w-sm text-center animate-pop-in">
        <Link to="/" aria-label="Multies home" className="inline-flex"><Logo /></Link>
        <div className="mx-auto mt-10 grid h-14 w-14 place-items-center rounded-full bg-ok-soft text-ok" aria-hidden><IconCheckCircle className="h-7 w-7" /></div>
        <h1 className="mt-5 text-[28px] font-bold leading-tight tracking-[-0.02em]">{copy.title}</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted" role="status">{copy.body}</p>
        <ButtonLink to={next} size="lg" className="mt-8 w-full">{from === "signup" ? "Open your dashboard" : "Back to Multies"}</ButtonLink>
      </div>
    </main>
  );
}
