import { router } from "expo-router";
import { IconButton } from "@/components/ui";
import { useNotificationCount } from "@/lib/queries";

/** The bell in screen headers: opens the notifications inbox, with a dot when anything is unread. */
export function NotificationBell() {
  const count = useNotificationCount();
  const n = count.data ?? 0;
  return <IconButton icon="bell" label={n ? `Notifications, ${n} unread` : "Notifications"} badge={n > 0} onPress={() => router.push("/notifications")} testID="open-notifications" />;
}
