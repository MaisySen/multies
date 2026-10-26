import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/web/lib/cn";
import { Spinner } from "./ui/spinner";

/**
 * R29: sign in buttons for other accounts, drawn to Google's sign in branding guidelines
 * (developers.google.com/identity/branding-guidelines): the standard four colour "G" at 20 px on
 * the left, 12 px padding each side and 10 px between the logo and the words, 14 px medium text,
 * a white button with a #747775 border in light mode and #131314 with a #8E918F border in dark
 * mode (the .mm-provider-btn rules in index.css). Microsoft and GitHub use the same shell so the
 * row reads as one set.
 */

/** The four colours Google publishes for its "G". */
export const GOOGLE_G_COLOURS = ["#EA4335", "#4285F4", "#FBBC05", "#34A853"] as const;

/** Google's standard "G" logo, as Google ships it in its sign in button. Never recoloured. */
export function GoogleGLogo({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true" focusable="false" data-testid="google-g">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
      <path fill="none" d="M0 0h48v48H0z" />
    </svg>
  );
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
