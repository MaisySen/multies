import { badgesFrom, type Badges } from "./counts";
import { taskBadgeCount } from "./badges";
import { useApprovals, useChatUnread, useCounts, useNotificationCount, useOverview, useTasks } from "./queries";

/** R34: every badge, from GET /api/counts when the server has it, else from the lists already loaded. */
export function useBadges(): Badges & { fromServer: boolean } {
  const pending = useApprovals("pending");
  const overview = useOverview();
  const chat = useChatUnread();
  const notif = useNotificationCount();
  const mine = useTasks({ assignee: "me" });
  const counts = useCounts();
  const b = badgesFrom(counts.data, {
    inbox: overview.data?.reduce((n, m) => n + (m.folders.inbox?.unread ?? 0), 0) ?? 0,
    chat: chat.data?.total ?? 0, mentions: chat.data?.mentions ?? 0,
    activity: notif.data ?? 0, tasks: taskBadgeCount(mine.data), approvals: pending.data?.length ?? 0,
  });
  return { ...b, fromServer: !!counts.data };
}
