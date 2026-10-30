import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import { EAS_PROJECT_ID, FEATURES } from "@/config";
import type { Api } from "@/api/endpoints";
import type { PushData } from "@/api/types";
import { secureStorage } from "./storage";
import { describePush, routeForPush } from "./push-events";

/**
 * Notifications for new mail, approval requests and tasks.
 *
 * Server push needs things only the owner can supply (docs/push.md): an EAS project id, Firebase
 * credentials for Android and an APNs key for iOS. Without them, or while the server has push
 * switched off, nothing here fails: the phone token step is skipped or the server stores the token
 * and sends nothing, and the app still checks for new approvals every 30 s while open.
 */
export const CHANNELS = { mail: "mail", approvals: "approvals", tasks: "tasks", chat: "chat" } as const;

/** Where the token this phone registered is kept, so sign out can remove it from the server. */
export const PUSH_TOKEN_KEY = "mymail.pushToken";

export function configureNotifications() {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldPlaySound: false, shouldSetBadge: true, shouldShowBanner: true, shouldShowList: true }),
  });
  if (Platform.OS === "android") {
    Notifications.setNotificationChannelAsync(CHANNELS.mail, { name: "New mail", importance: Notifications.AndroidImportance.DEFAULT, lightColor: "#0071E3", showBadge: true }).catch(() => {});
    Notifications.setNotificationChannelAsync(CHANNELS.approvals, { name: "Agent approvals", description: "When an agent asks to send a message", importance: Notifications.AndroidImportance.HIGH, lightColor: "#0071E3", showBadge: true }).catch(() => {});
    Notifications.setNotificationChannelAsync(CHANNELS.chat, { name: "Chat", description: "Mentions, direct messages and thread replies", importance: Notifications.AndroidImportance.HIGH, lightColor: "#0071E3", showBadge: true }).catch(() => {});
    Notifications.setNotificationChannelAsync(CHANNELS.tasks, { name: "Tasks", description: "Assigned tasks, comments, replies and due dates", importance: Notifications.AndroidImportance.DEFAULT, lightColor: "#0071E3", showBadge: true }).catch(() => {});
  }
}

export type PushState =
  | { kind: "unsupported"; reason: string }
  | { kind: "denied" }
  | { kind: "allowed"; token: string | null; registered: boolean; serverSends: boolean; note: string };

export async function permissionGranted(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  const p = await Notifications.getPermissionsAsync();
  return p.granted;
}

/**
 * Registers this phone with the server for push. With `prompt` it asks for permission first (the
 * Settings button); without it, it only goes ahead when permission was already given (after sign in).
 */
export async function registerPush(api: Api | null, opts: { prompt?: boolean } = {}): Promise<PushState> {
  if (Platform.OS === "web") return { kind: "unsupported", reason: "Notifications work in the iPhone and Android app." };
  const current = await Notifications.getPermissionsAsync();
  const granted = current.granted || (opts.prompt ? (await Notifications.requestPermissionsAsync()).granted : false);
  if (!granted) return { kind: "denied" };
  const local = (note: string): PushState => ({ kind: "allowed", token: null, registered: false, serverSends: false, note });
  if (!Device.isDevice) return local("Alerts on, while the app is open. Push needs a real phone.");
  if (!EAS_PROJECT_ID) return local("Alerts on, while the app is open. Push from the server is not set up yet.");
  let token: string;
  try {
    token = (await Notifications.getExpoPushTokenAsync({ projectId: EAS_PROJECT_ID })).data;
  } catch {
    return local("Alerts on, while the app is open. Push credentials are not set up yet.");
  }
  if (!FEATURES.pushServer || !api) return { kind: "allowed", token, registered: false, serverSends: false, note: "Alerts on, while the app is open." };
  try {
    const r = await api.registerPushDevice(token, Platform.OS === "ios" ? "ios" : "android");
    await secureStorage.set(PUSH_TOKEN_KEY, token).catch(() => {});
    return {
      kind: "allowed", token, registered: true, serverSends: r.enabled,
      note: r.enabled ? "Push is on for new mail, approvals, tasks and chat." : "This phone is registered. Push starts when Multies switches it on.",
    };
  } catch {
    return { kind: "allowed", token, registered: false, serverSends: false, note: "Alerts on, while the app is open. Couldn't reach Multies to register this phone." };
  }
}

/** Removes this phone's token from the server. Called at sign out, before the session ends. */
export async function unregisterPush(api: Api | null): Promise<boolean> {
  if (Platform.OS === "web") return false;
  const token = await secureStorage.get(PUSH_TOKEN_KEY).catch(() => null);
  if (!token) return false;
  await secureStorage.remove(PUSH_TOKEN_KEY).catch(() => {});
  if (!api) return false;
  return api.unregisterPushDevice(token).then(() => true, () => false);
}

/** Shows a notification for a server push, worded from the item the app fetched. */
export async function presentPush(api: Api | null, d: PushData) {
  if (Platform.OS === "web") return;
  const text = await describePush(api, d);
  await Notifications.scheduleNotificationAsync({
    content: { title: text.title, body: text.body, data: { url: routeForPush(d), type: d.type, id: d.id } },
    trigger: Platform.OS === "android" ? { channelId: text.channel } : null,
  });
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
