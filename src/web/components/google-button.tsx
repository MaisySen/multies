import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/web/lib/cn";
import { Spinner } from "./ui/spinner";

/**
 * R29: sign in buttons for other accounts, drawn to Google's sign in branding guidelines
 * (developers.google.com/identity/branding-guidelines): Google's "G" (R30: Google's own asset) at 20 px on
 * the left, 12 px padding each side and 10 px between the logo and the words, 14 px medium text,
 * a white button with a #747775 border in light mode and #131314 with a #8E918F border in dark
 * mode (the .mm-provider-btn rules in index.css). Microsoft and GitHub use the same shell so the
 * row reads as one set.
 */

/**
 * R30: the "G" is Google's own downloadable sign in asset (signin-assets.zip from
 * developers.google.com/identity/branding-guidelines, "Android + Web/SVG", icon only, square),
 * with only the button frame removed and the view box cropped to the 20 x 20 logo. The file is
 * identical in the Light, Dark and Neutral sets. It is served as an image, so it is cached, not
 * subject to the page's inline style rules, and never recoloured.
 */
export const GOOGLE_G_SRC = "/brand/google-g.svg";

/** The colours of Google's current gradient "G" (the solid stops in Google's asset). */
export const GOOGLE_G_COLOURS = ["#3186FF", "#FF4641", "#0EBC5F", "#FFCC00"] as const;

/** Google's "G" logo, exactly as Google ships it. */
export function GoogleGLogo({ className = "h-5 w-5" }: { className?: string }) {
  return <img src={GOOGLE_G_SRC} width={20} height={20} alt="" aria-hidden="true" draggable={false} decoding="async" className={className} data-testid="google-g" />;
}

/** Microsoft's four squares. */
export function MicrosoftLogo({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 21 21" className={className} aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}

/** GitHub's mark, in the text colour so it reads in light and dark. */
export function GitHubLogo({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true" focusable="false" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export interface ProviderButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  logo: ReactNode;
  loading?: boolean;
}

/** The shared shell: 40 px tall (44 px on phones), logo left, words beside it, centred as a group. */
export function ProviderButton({ logo, loading, className, children, disabled, type = "button", ...rest }: ProviderButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "mm-provider-btn relative inline-flex h-10 w-full items-center justify-center gap-2.5 whitespace-nowrap rounded-lg px-3 text-sm font-medium",
        "transition-[background-color,box-shadow,opacity] duration-150 ease-out select-none max-sm:min-h-11",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0071E3]/50 disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
      {...rest}
    >
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">{loading ? <Spinner className="h-4 w-4" /> : logo}</span>
      <span className="mm-provider-btn-label">{children}</span>
    </button>
  );
}

/** "Continue with Google" (or another of Google's approved labels) with the standard "G". */
export function GoogleSignInButton({ label = "Continue with Google", ...rest }: Omit<ProviderButtonProps, "logo" | "children"> & { label?: "Continue with Google" | "Sign in with Google" | "Sign up with Google" }) {
  return <ProviderButton logo={<GoogleGLogo />} {...rest}>{label}</ProviderButton>;
}
