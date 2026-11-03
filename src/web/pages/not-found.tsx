import { IconArrowLeft } from "@/web/components/ui/icon";
import { Link } from "react-router";
import { ButtonLink } from "@/web/components/ui/button";
import { Logo } from "@/web/components/logo";

/** `embedded` (R67): inside a layout that already has the page's main landmark, so this is a plain block. */
export function NotFound({ embedded = false }: { embedded?: boolean }) {
  const Box = embedded ? "div" : "main";
  return (
    <Box className="grid min-h-dvh place-items-center bg-bg px-6 py-16 text-center">
      <div className="w-full max-w-md animate-pop-in">
        <Link to="/" aria-label="Multies home" className="inline-flex items-center max-sm:min-h-11"><Logo /></Link>
        <p className="mt-12 text-[13px] font-semibold tabular-nums tracking-wide text-subtle">Error 404</p>
        <h1 className="mt-2 text-[34px] font-bold leading-tight tracking-[-0.025em]">This page bounced.</h1>
        <p className="mx-auto mt-3 max-w-sm text-[17px] leading-relaxed text-muted">The address doesn't exist, like mail to a mailbox nobody created. Check the link, or head back.</p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <ButtonLink to="/" size="lg"><IconArrowLeft className="h-4 w-4" aria-hidden />Go home</ButtonLink>
          <ButtonLink to="/app" size="lg" variant="secondary">Open the dashboard</ButtonLink>
        </div>
        <p className="mt-8 text-[13px] text-subtle">Still stuck? <Link to="/support" className="font-medium text-brand-hover hover:underline">Contact support</Link></p>
      </div>
    </Box>
  );
}
