import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ButtonLink, buttonClass } from "@/web/components/ui/button";
import { IconDownload, IconMonitor } from "@/web/components/ui/icon";

export const MOUSY_DOWNLOAD_URL = "/downloads/Mousy.app.zip";
export const MOUSY_SHA256 = "3385330f1ea4fdf6ecf4ff3214becad1942857205eadbc5e97ee532bfa8a7fb0";

export function MousyDownload({ compact = false }: { compact?: boolean }) {
  // Keep SSR neutral. A phone or Windows visitor should not mistake this for a web feature.
  const [platform, setPlatform] = useState<"mac" | "other" | "unknown">("unknown");
  useEffect(() => {
    setPlatform(/Macintosh|MacIntel/.test(navigator.userAgent + navigator.platform) && navigator.maxTouchPoints < 2 ? "mac" : "other");
  }, []);
  return (
    <div className={compact ? "space-y-1" : "space-y-3"}>
      <a href={MOUSY_DOWNLOAD_URL} download className={buttonClass("primary", compact ? "sm" : "lg", compact ? "max-sm:w-full" : "w-full sm:w-auto")} aria-label="Download Mousy for macOS, ZIP archive">
        <IconDownload className="h-4 w-4" aria-hidden />Download for macOS
      </a>
      {platform === "other" && <p className="max-w-sm text-xs leading-relaxed text-muted">For your Mac, not this device. Open this page on a Mac with macOS 15 or later.</p>}
      {!compact && <p className="text-sm text-muted">5.6 MB ZIP · Apple Silicon + Intel · macOS 15+</p>
    </div>
  );
}

export function MousyPage() {
  return (
    <div className="mx-auto max-w-6xl px-5 pb-24 pt-32 sm:pt-40" data-testid="mousy-page">
      <Link to="/features" className="text-sm text-muted hover:text-fg">Multies / Features</Link>
      <div className="mt-6 grid items-start gap-10 lg:grid-cols-[1.15fr_1fr] lg:gap-16">
        <div>
          <p className="text-sm font-medium text-brand-hover">Mousy · A Multies feature for your Mac</p>
          <h1 className="mt-3 max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">Hands-free. Still you.</h1>
          <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-muted">Turn your head to move the pointer. Pause to click. Mousy brings hands-free pointing to your Mac, so you can keep moving through your Multies workspace and the rest of your day.</p>
          <div className="mt-7"><MousyDownload /></div>
          <p className="mt-4 max-w-lg text-sm leading-relaxed text-muted">Early build, ad-hoc signed and not notarized. macOS may block the first launch. <a href="#setup" className="text-brand-hover underline underline-offset-2">Read the setup steps</a> before opening.</p>
        </div>
        <aside className="rounded-xl border border-line bg-surface p-6 sm:p-8" aria-labelledby="mousy-requirements">
          <div className="mb-5 flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-lg bg-brand-soft text-brand-hover"><IconMonitor className="h-5 w-5" aria-hidden /></span><div><p className="text-sm font-semibold">Multies</p><p className="text-sm text-muted">Mousy for macOS</p></div></div>
          <h2 id="mousy-requirements" className="text-lg font-semibold tracking-tight">A Mac. Your headphones. You.</h2>
          <ul className="mt-4 space-y-3 text-sm leading-relaxed text-muted">
            <li>macOS 15 or later, on Apple Silicon or Intel.</li>
            <li>Head-tracking headphones: AirPods Pro, AirPods Max, AirPods (3rd generation or later), or Beats Fit Pro.</li>
            <li>Accessibility and headphone-motion permissions, so Mousy can move your pointer.</li>
          </ul>
          <p className="mt-5 border-t border-line pt-5 text-sm leading-relaxed text-muted">A native Mac app is needed to read headphone motion and control the pointer. Nothing to install in your browser.</p>
        </aside>
      </div>

      <section className="mt-16 border-t border-line pt-10 sm:mt-20" aria-labelledby="mousy-how">
        <h2 id="mousy-how" className="text-2xl font-semibold tracking-tight">Small movements. Familiar controls.</h2>
        <div className="mt-6 grid gap-6 sm:grid-cols-3">
          {[
            ["Point", "Gently turn your head to move the pointer. Tune speed, smoothing and the quiet zone to suit you."],
            ["Click", "Rest on a target for dwell clicking, or use the click and gesture options in the Mac app."],
            ["Pause", "Keep your usual mouse close by. Pause head tracking from the menu bar whenever you want a break."],
          ].map(([title, text]) => <div key={title}><h3 className="text-[15px] font-semibold">{title}</h3><p className="mt-2 text-sm leading-relaxed text-muted">{text}</p></div>)}
        </div>
      </section>

      <section id="setup" className="mt-16 scroll-mt-24 grid gap-8 border-t border-line pt-10 lg:grid-cols-[1fr_2fr]" aria-labelledby="mousy-setup">
        <div><h2 id="mousy-setup" className="text-2xl font-semibold tracking-tight">Set up on your Mac</h2><p className="mt-3 text-sm leading-relaxed text-muted">The guided tour walks you through permissions, connecting headphones and trying your first click.</p></div>
        <ol className="space-y-5">
          {[
            ["Install", <>Download and unzip the archive. Move <code>Mousy.app</code> into your Applications folder, then open it.</>],
            ["Allow the first launch", <>This early build is not Developer ID signed or notarized. If macOS blocks it, check <strong>System Settings → Privacy &amp; Security</strong> after the launch attempt. A blocked app may offer an Open Anyway option. Do not turn off Gatekeeper.</>],
            ["Give permission", <>Follow the tour to allow Accessibility and headphone motion. Put on your supported headphones and connect them to the Mac.</>],
            ["Try it gently", <>Keep your normal mouse available. Use the tour target to try pointing and clicking, then adjust sensitivity and dwell timing in Mousy.</>],
          ].map(([title, text], i) => <li key={i} className="flex gap-4"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-fill text-xs font-medium" aria-hidden>{i + 1}</span><div><h3 className="text-sm font-semibold">{title}</h3><p className="mt-1 text-sm leading-relaxed text-muted">{text}</p></div></li>)}
        </ol>
      </section>

      <section className="mt-12 rounded-xl border border-line bg-surface p-6" aria-labelledby="mousy-limits">
        <h2 id="mousy-limits" className="text-lg font-semibold">What this build does, and what still needs testing</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-muted">
          <li>The downloadable build passed its automated Mac build and unit tests, including telemetry-privacy tests, plus signing, launch and guided-tour checks on macOS CI. Real head tracking still needs testing with physical headphones on a Mac.</li>
          <li>This download processes motion on your Mac. Its optional crash-reporting and usage-diagnostics code (Sentry and PostHog) ships with no server configured and is off by default, so as delivered it makes no network requests. Head-motion data, screen content and keystrokes are never collected. Automatic updates are off.</li>
          <li>When replacing this ad-hoc signed app, you may need to remove the old Accessibility entry and grant permission again.</li>
        </ul>
        <details className="mt-5 border-t border-line pt-4 text-sm"><summary className="cursor-pointer font-medium">Verify your download</summary><p className="mt-3 text-muted">SHA-256 of Mousy.app.zip</p><code className="mt-2 block break-all text-xs leading-relaxed text-muted">{MOUSY_SHA256}</code></details>
      </section>

      <div className="mt-10 max-w-3xl text-xs leading-relaxed text-muted">
        <p>Mousy is a Multies feature built on <a href="https://github.com/m-afham/AirCursor" className="underline underline-offset-2">AirCursor</a> by m-afham, under the MIT licence. LICENSE.txt and MOUSY-NOTICE.txt are included in the download.</p>
        <p className="mt-2">AirPods, Beats and macOS are Apple trademarks. Multies is not affiliated with or endorsed by Apple.</p>
        <ButtonLink to="/app" variant="ghost" className="-ml-4 mt-5">Back to Multies</ButtonLink>
      </div>
    </div>
  );
}
