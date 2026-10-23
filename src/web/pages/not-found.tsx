import { ButtonLink } from "@/web/components/ui/button";
import { Logo } from "@/web/components/logo";

export function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-6 text-center">
      <div>
        <Logo className="mb-10 justify-center" />
        <p className="font-mono text-sm text-brand-hover">404</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">This page bounced.</h1>
        <p className="mt-3 text-muted">The address doesn't exist — like mail to a mailbox nobody created.</p>
        <div className="mt-8 flex justify-center gap-3">
          <ButtonLink to="/">Go home</ButtonLink>
          <ButtonLink to="/app" variant="secondary">Dashboard</ButtonLink>
        </div>
      </div>
    </main>
  );
}
