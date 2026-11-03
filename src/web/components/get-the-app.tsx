import { IconSmartphone } from "@/web/components/ui/icon";
import { buttonClass } from "@/web/components/ui/button";
import { getTheAppView } from "@/shared/get-the-app";

/**
 * WEB1: the Get the app block on the home and support pages. Everything it shows comes from src/shared/get-the-app.ts:
 * store links only when a real listing is set, the public beta link only when it is switched on. Plain links, no
 * third party script, badge image or embed, so the page security policy is unchanged.
 */
export function GetTheApp({ headingId = "get-app-title", compact = false }: { headingId?: string; compact?: boolean }) {
  const v = getTheAppView();
  return (
    <div data-testid="get-the-app">
      {compact ? <IconSmartphone className="h-5 w-5 text-accent" aria-hidden /> : <p className="text-sm font-medium text-brand-hover">Get the app</p>}
      <h2 id={headingId} className={compact ? "mt-3 font-semibold" : "mt-2 text-3xl font-semibold tracking-tight sm:text-4xl"}>
        {compact ? "Get the app" : "Multies on your phone."}
      </h2>
      <p className={compact ? "mt-1.5 text-[14px] text-muted" : "mt-4 max-w-2xl text-[15px] leading-relaxed text-muted"}>
        Multies works in the browser on any phone or computer: sign in at multies.si.{" "}
        {v.onStores
          ? "The phone app is free, with no purchases."
          : "The iPhone and Android apps are in testing and are not in the stores yet."}
      </p>
      {(v.onStores || v.beta) && (
        <div className="mt-4 flex flex-col gap-3 sm:flex-row" data-testid="get-the-app-links">
          {v.appStore && <a href={v.appStore} className={buttonClass("outline", "lg")} rel="noopener"><IconSmartphone className="h-4 w-4" aria-hidden />Download on the App Store</a>}
          {v.googlePlay && <a href={v.googlePlay} className={buttonClass("outline", "lg")} rel="noopener"><IconSmartphone className="h-4 w-4" aria-hidden />Get it on Google Play</a>}
          {v.beta && <a href={v.beta} className={buttonClass("primary", "lg")} rel="noopener" data-testid="public-beta-link"><IconSmartphone className="h-4 w-4" aria-hidden />Join the {v.betaPlatform} public beta</a>}
        </div>
      )}
      {v.beta && <p className="mt-2 text-[13px] text-subtle">The public beta runs through Apple TestFlight. Testers get new features first and can send feedback from the app.</p>}
    </div>
  );
}
