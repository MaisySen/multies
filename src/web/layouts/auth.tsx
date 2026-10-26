import { Suspense, type ReactNode } from "react";
import { Link, Outlet } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Logo } from "@/web/components/logo";
import { authProvidersQuery } from "@/web/lib/auth-providers";

/**
 * R30: the logo and the card paint together, once, at their final size. The card is centred, so
 * painting the logo first (while the page's code or the providers read was still on its way) and the
 * card later moved everything already on screen: 0.37 of layout shift on sign in (Lighthouse mobile).
 * Until both are ready the screen holds an empty full height block, exactly as before.
 */
const hold = <div className="min-h-dvh" aria-busy="true" data-testid="auth-hold" />;

function WhenProvidersKnown({ children }: { children: ReactNode }) {
  const providers = useQuery(authProvidersQuery);
  // An error still shows the page (it handles a missing providers answer itself).
  return providers.isPending ? hold : <>{children}</>;
}

export function AuthLayout() {
  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden px-5 py-12">
      <Suspense fallback={hold}>
        <WhenProvidersKnown>
          <main className="relative w-full max-w-[400px]">
            <Link to="/" className="mb-8 flex justify-center" aria-label="Multies home"><Logo /></Link>
            <Outlet />
          </main>
        </WhenProvidersKnown>
      </Suspense>
    </div>
  );
}
