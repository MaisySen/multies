/**
 * WEB1: where people get the Multies phone apps, in one place. The public pages (home, support) read only this.
 *
 * A store badge shows only when its URL is set. Both listings answered 404 on 2 Nov 2026 (the apps are not on the
 * stores yet), so both are null and no dead link is shown. When a listing goes live, paste the real store URL here.
 *
 * The public beta block shows only when publicBeta.visible is true. The TestFlight link is wired but stays hidden
 * until Apple approves the beta review; then flip visible to true (nothing else changes).
 */
export interface GetTheAppConfig {
  appStoreUrl: string | null;
  googlePlayUrl: string | null;
  publicBeta: { url: string; visible: boolean; platform: string };
}

export const GET_THE_APP: GetTheAppConfig = {
  appStoreUrl: null,
  googlePlayUrl: null,
  publicBeta: { url: "https://testflight.apple.com/join/RncpPJ1t", visible: false, platform: "iPhone" },
};

/** Only https links to the two app stores and TestFlight are allowed, so a typo cannot point people elsewhere. */
export const STORE_HOSTS = ["apps.apple.com", "play.google.com", "testflight.apple.com"] as const;

export function safeStoreUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (STORE_HOSTS as readonly string[]).includes(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}

/** What the Get the app section shows for a config: store links, the beta link, or neither. */
export function getTheAppView(cfg: GetTheAppConfig = GET_THE_APP) {
  const appStore = safeStoreUrl(cfg.appStoreUrl);
  const googlePlay = safeStoreUrl(cfg.googlePlayUrl);
  const beta = cfg.publicBeta.visible ? safeStoreUrl(cfg.publicBeta.url) : null;
  return { appStore, googlePlay, beta, betaPlatform: cfg.publicBeta.platform, onStores: !!(appStore || googlePlay) };
}
