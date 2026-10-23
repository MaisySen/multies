import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import { EAS_PROJECT_ID, FEATURES } from "@/config";
import type { Api } from "@/api/endpoints";

/**
 * Notifications for new mail and approval requests.
 * Push from the server needs three things the owner supplies (docs/push.md): an EAS project id,
 * Firebase credentials for Android and an APNs key for iOS, plus the small API endpoint behind
 * FEATURES.pushServer. Until then the app checks for new approvals while open and raises a local
 * notification, which needs none of those.
 */
export const CHANNELS = { mail: "mail", approvals: "approvals" } as const;

export function configureNotifications() {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldPlaySound: false, shouldSetBadge: true, shouldShowBanner: true, shouldShowList: true }),
  });
  if (Platform.OS === "android") {
    Notifications.setNotificationChannelAsync(CHANNELS.mail, { name: "New mail", importance: Notifications.AndroidImportance.DEFAULT, lightColor: "#ff6a3d" }).catch(() => {});
    Notifications.setNotificationChannelAsync(CHANNELS.approvals, { name: "Agent approvals", description: "When an agent asks to send a message", importance: Notifications.AndroidImportance.HIGH, lightColor: "#ff6a3d" }).catch(() => {});
  }
}

export type PushState =
  | { kind: "unsupported"; reason: string }
  | { kind: "denied" }
  | { kind: "allowed"; token: string | null; registered: boolean; note: string };

export async function permissionGranted(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  const p = await Notifications.getPermissionsAsync();
  return p.granted;
}

export async function enablePush(api: Api | null): Promise<PushState> {
  if (Platform.OS === "web") return { kind: "unsupported", reason: "Notifications work in the iPhone and Android app." };
  const current = await Notifications.getPermissionsAsync();
  const granted = current.granted || (await Notifications.requestPermissionsAsync()).granted;
  if (!granted) return { kind: "denied" };
  if (!Device.isDevice) return { kind: "allowed", token: null, registered: false, note: "Alerts on, while the app is open. Push needs a real phone." };
  if (!EAS_PROJECT_ID) return { kind: "allowed", token: null, registered: false, note: "Alerts on, while the app is open. Push from the server is not set up yet." };
  try {
    const token = (await Notifications.getExpoPushTokenAsync({ projectId: EAS_PROJECT_ID })).data;
    let registered = false;
    if (FEATURES.pushServer && api) {
      registered = await registerDevice(api, token).then(() => true, () => false);
    }
    return { kind: "allowed", token, registered, note: registered ? "Push is on for new mail and approvals." : "Alerts on, while the app is open. The server doesn't send push yet." };
  } catch {
    return { kind: "allowed", token: null, registered: false, note: "Alerts on, while the app is open. Push credentials are not set up yet." };
  }
}

/** Calls the endpoint described in docs/push.md. Only used when FEATURES.pushServer is on. */
async function registerDevice(api: Api, token: string) {
  await api.registerPushDevice(token, Platform.OS);
}
export async function notifyApprovals(count: number, firstSubject?: string) {
  if (Platform.OS === "web" || !(await permissionGranted())) return;
  await Notifications.scheduleNotificationAsync({
    content: {
      title: count === 1 ? "An agent wants to send a message" : `${count} messages waiting for approval`,
      body: firstSubject ? `"${firstSubject}". Tap to review.` : "Tap to review.",
      data: { url: "/approvals" },
    },
    trigger: Platform.OS === "android" ? { channelId: CHANNELS.approvals } : null,
  });
}
