/**
 * R32: Settings, Notifications: "Browser notifications". Shown only when the server has web push set up
 * (VAPID public key in /api/config) and this browser can do it. The same switches below (per category,
 * "push") decide which events arrive; a notification names what happened and opens it, never message text.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { IconDevices } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Card, Switch } from "@/web/components/ui/misc";
import { browserPushState, browserPushSupported, disableBrowserPush, enableBrowserPush, type BrowserPushState } from "@/web/lib/sw-client";

export function BrowserNotifications() {
  const config = useQuery({ queryKey: ["config"], queryFn: () => api.get<{ vapidPublicKey?: string | null }>("/config"), staleTime: 300_000 });
  const key = config.data?.vapidPublicKey ?? null;
  const [state, setState] = useState<BrowserPushState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (key && browserPushSupported()) void browserPushState().then(setState, () => setState("off")); }, [key]);
  if (!key || !browserPushSupported()) return null;
  const toggle = async (on: boolean) => {
    setBusy(true);
    try { setState(on ? await enableBrowserPush(key) : await disableBrowserPush()); }
    catch (e) { showError(e as Error); }
    finally { setBusy(false); }
  };
  return (
    <Card className="flex items-start gap-3 p-4" data-testid="browser-notifications">
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#0071E3]/10 text-[#0071E3]" aria-hidden="true"><IconDevices className="h-4 w-4" /></span>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium" id="browser-notifications-title">Browser notifications</div>
        <p className="text-[13px] text-muted">
          {state === "denied"
            ? "This browser blocks notifications from Multies. Allow them in the browser's site settings, then turn this on."
            : "Get an alert on this computer for the categories you send to your phone, even when Multies is in the background."}
        </p>
      </div>
      <Switch label="Browser notifications" checked={state === "on"} disabled={busy || state === null || state === "denied"} onChange={(v) => void toggle(v)} />
    </Card>
  );
}
