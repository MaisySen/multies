import { useState } from "react";
import { toast } from "sonner";
import { GoogleSignInButton, MicrosoftLogo, ProviderButton } from "./google-button";
import { authClient, unwrap } from "@/web/lib/auth-client";
import { useConfig } from "@/web/lib/queries";
import { tr } from "@/web/i18n"; // R104

/**
 * Round 25: "Continue with Google" and "Continue with Microsoft". Each starts the identity
 * provider's sign in with its connection named (connection=google-oauth2 or windowslive), so the
 * provider goes straight to Google or Microsoft. Shown only for the connections this deployment
 * turns on (AUTH0_SOCIAL_CONNECTIONS, read from /api/config).
 */
export type SocialConnectionId = "google-oauth2" | "windowslive";

export const SOCIAL_LABELS: Record<SocialConnectionId, string> = { "google-oauth2": "Google", windowslive: "Microsoft" };

/** Google's standard "G" and Microsoft's squares (R29: from google-button.tsx, to Google's branding rules). */
export { GoogleGLogo as GoogleMark, MicrosoftLogo as MicrosoftMark } from "./google-button";

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
      {list.map((c) => c === "google-oauth2"
        ? <GoogleSignInButton key={c} loading={busy === c} disabled={!!busy && busy !== c} onClick={() => go(c)} data-testid={`social-${c}`} />
        : <ProviderButton key={c} logo={<MicrosoftLogo />} loading={busy === c} disabled={!!busy && busy !== c} onClick={() => go(c)} data-testid={`social-${c}`}>{tr("auth.continue_with", { name: SOCIAL_LABELS[c] })}</ProviderButton>)}
    </div>
  );
}
