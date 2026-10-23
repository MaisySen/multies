import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { endpoints, type Api } from "@/api/endpoints";
import { HttpTransport } from "@/api/transport";
import type { Jar } from "./cookies";
import { secureStorage } from "./storage";
import { presentPush } from "./push";
import { extractPushData } from "./push-events";
import { JAR_KEY, MODE_KEY } from "./session-keys";

/**
 * Runs for every server push, with the app open, in the background or closed. The push carries
 * only { type, id }; this fetches the item with the saved session and shows the notification.
 * Defined at module scope, as expo-task-manager needs, and imported by the root layout.
 */
export const PUSH_TASK = "mymail-push";

async function backgroundApi(): Promise<Api | null> {
  if ((await secureStorage.get(MODE_KEY).catch(() => null)) === "sample") return null;
  const raw = await secureStorage.get(JAR_KEY).catch(() => null);
  if (!raw) return null;
  let jar: Jar = JSON.parse(raw) as Jar;
  return endpoints(new HttpTransport({ get: () => jar, set: (j) => { jar = j; secureStorage.set(JAR_KEY, JSON.stringify(j)).catch(() => {}); } }));
}

if (Platform.OS !== "web") {
  TaskManager.defineTask<Notifications.NotificationTaskPayload>(PUSH_TASK, async ({ data }) => {
    // A tapped notification also lands here on Android; the layout's listener opens the screen.
    if (!data || "actionIdentifier" in data) return Notifications.BackgroundNotificationTaskResult.NoData;
    const d = extractPushData(data);
    if (!d) return Notifications.BackgroundNotificationTaskResult.NoData;
    try {
      await presentPush(await backgroundApi(), d);
      return Notifications.BackgroundNotificationTaskResult.NewData;
    } catch {
      return Notifications.BackgroundNotificationTaskResult.Failed;
    }
  });
  Notifications.registerTaskAsync(PUSH_TASK).catch(() => {});
}
