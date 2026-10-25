import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/web/components/ui/button";
import { authClient, unwrap } from "@/web/lib/auth-client";
import { useConfig } from "@/web/lib/queries";

/**
 * Round 25: "Continue with Google" and "Continue with Microsoft". Each starts the identity
 * provider's sign in with its connection named (connection=google-oauth2 or windowslive), so the
 * provider goes straight to Google or Microsoft. Shown only for the connections this deployment
 * turns on (AUTH0_SOCIAL_CONNECTIONS, read from /api/config).
 */
export type SocialConnectionId = "google-oauth2" | "windowslive";

export const SOCIAL_LABELS: Record<SocialConnectionId, string> = { "google-oauth2": "Google", windowslive: "Microsoft" };

/** Google's "G" mark, the brand colours as published. */
export function GoogleMark({ className = "h-[18px] w-[18px]" }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

/** Microsoft's four squares. */
export function MicrosoftMark({ className = "h-[16px] w-[16px]" }: { className?: string }) {
  return (
    <svg viewBox="0 0 21 21" className={className} aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}

/** The connections from /api/config this page may show, in a fixed order. */
export function visibleSocialConnections(list: unknown): SocialConnectionId[] {
  const known: SocialConnectionId[] = ["google-oauth2", "windowslive"];
  return Array.isArray(list) ? known.filter((c) => list.includes(c)) : [];
}

export function SocialSignInButtons({ callbackURL, loginHint }: { callbackURL: string; loginHint?: string }) {
  const config = useConfig();
  const [busy, setBusy] = useState<SocialConnectionId | null>(null);
  const list = visibleSocialConnections(config.data?.socialConnections);
  if (!list.length) return null;
  const go = async (connection: SocialConnectionId) => {
    setBusy(connection);
    try {
      await unwrap(authClient.signIn.social({
        provider: "auth0", callbackURL, errorCallbackURL: "/login?error=oauth",
        ...(loginHint ? { loginHint } : {}),
        additionalParams: { connection },
      }));
    } catch (e) { toast.error(e instanceof Error ? e.message : "Sign in failed"); setBusy(null); }
  };
  return (
    <div className="space-y-2" data-testid="social-sign-in">
      {list.map((c) => (
        <Button key={c} variant="outline" size="lg" className="w-full bg-surface" loading={busy === c} disabled={!!busy && busy !== c} onClick={() => go(c)} data-testid={`social-${c}`}>
          {busy !== c && (c === "google-oauth2" ? <GoogleMark /> : <MicrosoftMark />)}
          Continue with {SOCIAL_LABELS[c]}
        </Button>
      ))}
    </div>
  );
}
