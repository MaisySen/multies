import { router } from "expo-router";
import { tr } from "@/i18n";
import { IconButton } from "@/components/ui";
import { useNotificationCount } from "@/lib/queries";

/** The bell in screen headers: opens the notifications inbox, with a dot when anything is unread. */
export function NotificationBell() {
  const count = useNotificationCount();
  const n = count.data ?? 0;
  return <IconButton icon="bell" label={n ? tr("m.common.label_count_unread", { label: tr("m.notif.notifications"), count: n }) : tr("m.notif.notifications")} badge={n > 0} onPress={() => router.push("/notifications")} testID="open-notifications" />;
}
