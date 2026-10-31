import { RefreshControl, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import { Badge, Icon, LargeTitle, PressableCard, TILE, type IconName, type TileColor } from "@/components/ui";
import { useCollapse } from "@/components/chrome";
import { NotificationBell } from "@/components/notification-bell";
import { useBadges } from "@/lib/use-badges";
import { useMeetings, useTasks } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { useInboxBadge, useSocialPosts, useSocialStatus } from "@/lib/social-queries";
import { badgeText } from "@/lib/social-inbox";
import { socialSummary } from "@/lib/social";
import { dayFrom } from "@/lib/tasks";
import { focusTasks, greeting, nextMeeting, whenLabel } from "@/lib/today";
import { tick } from "@/lib/haptics";
import { FEATURES } from "@/config";
import { colors, font, radius, space } from "@/theme";

/**
 * R34: the Today home. One glance at what needs you: unread mail, tasks due today and overdue,
 * the next meeting, mentions and approvals waiting. Counts come from GET /api/counts.
 */
export default function Today() {
  const insets = useSafeAreaInsets();
  const { me } = useSession();
  const b = useBadges();
  const meetings = useMeetings();
  const mine = useTasks({ assignee: "me" });
  const qc = useQueryClient();
  const collapse = useCollapse();
  const now = new Date();
  const next = nextMeeting(meetings.data?.meetings, now);
  const focus = FEATURES.tasks ? focusTasks(mine.data, dayFrom(0, now)) : [];
  const first = me?.user.name?.split(" ")[0];
  // 1.10.6: a Social card when posting is on for this workspace: the newest post, or how many need a look.
  const socialOn = useSocialStatus();
  const posts = useSocialPosts(!!socialOn.data?.available);
  const social = socialOn.data?.available ? socialSummary(posts.data) : null;
  // 1.10.8: open conversations in the Social inbox, as a badge on the card (quiet where the inbox is off).
  const inboxOpen = badgeText(useInboxBadge(!!socialOn.data?.available).data);
  const date = now.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" });
  const go = (path: string) => { tick(); router.push(path as never); };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <LargeTitle title="Today" subtitle={date} top={insets.top} collapsed={collapse.collapsed} right={<NotificationBell />} />
      <ScrollView {...collapse.scrollProps} contentContainerStyle={{ padding: space.lg, paddingTop: space.sm, gap: space.md, paddingBottom: space.xxl * 2 }} testID="today"
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => { qc.invalidateQueries(); }} tintColor={colors.brand} />}>
        <Text style={[font.heading, { marginBottom: space.xs }]}>{first ? `${greeting(now)}, ${first}` : greeting(now)}</Text>

        <View style={{ flexDirection: "row", gap: space.md }}>
          <Stat testID="today-mail" icon="inbox" tile="blue" value={b.inbox} label="Unread mail" onPress={() => go("/inbox")} />
          {FEATURES.tasks ? <Stat testID="today-tasks" icon="tasks" tile="orange" value={b.tasks} label="Due or overdue" onPress={() => go("/tasks")} /> : null}
        </View>
        <View style={{ flexDirection: "row", gap: space.md }}>
          <Stat testID="today-mentions" icon="mention" tile="purple" value={b.mentions} label={b.mentions === 1 ? "Mention" : "Mentions"} onPress={() => go("/chat")} />
          <Stat testID="today-approvals" icon="approvals" tile="green" value={b.approvals} label="Approvals waiting" onPress={() => go("/approvals")} />
        </View>

        <PressableCard onPress={() => go("/meetings")} testID="today-meeting" accessibilityRole="button"
          accessibilityLabel={next ? `Next meeting, ${next.title}, ${whenLabel(next.startsAt, now)}` : "No meetings coming up"} style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
          <Tile icon="video" tile="teal" />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={font.tiny}>Next meeting</Text>
            <Text style={font.headline} numberOfLines={1}>{next ? next.title : "Nothing coming up"}</Text>
          </View>
          {next ? <Text style={{ color: colors.brand, fontWeight: "600", fontSize: 15 }}>{whenLabel(next.startsAt, now)}</Text> : <Icon name="chevron-right" size={18} color={colors.subtle} />}
        </PressableCard>

        {social ? (
          <PressableCard onPress={() => go(inboxOpen && !social.failed ? "/social?tab=inbox" : "/social")} testID="today-social" accessibilityRole="button"
            accessibilityLabel={`Social, ${social.title}${social.detail ? `, ${social.detail}` : ""}${inboxOpen ? `, ${inboxOpen} open in the inbox` : ""}`} style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
            <Tile icon="send" tile="pink" />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={font.tiny}>Social</Text>
              <Text style={font.headline} numberOfLines={1}>{social.title}</Text>
              {social.detail ? <Text style={[font.tiny, { color: colors.subtle }]} numberOfLines={1}>{social.detail}</Text> : null}
            </View>
            {social.failed ? <Badge label={`${social.failed} failed`} tone="bad" /> : inboxOpen ? <Badge label={`${inboxOpen} to answer`} tone="brand" icon="inbox" /> : <Icon name="chevron-right" size={18} color={colors.subtle} />}
          </PressableCard>
        ) : null}

        {focus.length ? (
          <View style={{ gap: space.sm, marginTop: space.sm }}>
            <Text style={[font.small, { fontWeight: "600", color: colors.fg }]}>Focus</Text>
            {focus.map((t) => {
              const late = t.due!.slice(0, 10) < dayFrom(0, now);
              return (
                <PressableCard key={t.id} onPress={() => go(`/task/${t.id}`)} accessibilityRole="button" accessibilityLabel={`${t.title}, ${late ? "overdue" : "due today"}`}
                  style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.md }}>
                  <Icon name={late ? "overdue" : "due"} size={20} color={late ? colors.bad : colors.brand} filled />
                  <Text style={[font.body, { flex: 1 }]} numberOfLines={1}>{t.title}</Text>
                  <Text style={{ color: late ? colors.bad : colors.subtle, fontSize: 13 }}>{late ? "Overdue" : "Today"}</Text>
                </PressableCard>
              );
            })}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function Tile({ icon, tile }: { icon: IconName; tile: TileColor }) {
  return <View style={{ width: 36, height: 36, borderRadius: 9, backgroundColor: TILE[tile], alignItems: "center", justifyContent: "center" }}><Icon name={icon} size={20} color="#FFFFFF" filled /></View>;
}

function Stat({ icon, tile, value, label, onPress, testID }: { icon: IconName; tile: TileColor; value: number; label: string; onPress: () => void; testID: string }) {
  return (
    <PressableCard onPress={onPress} testID={testID} accessibilityRole="button" accessibilityLabel={`${label}, ${value}`} style={{ flex: 1, gap: space.sm, borderRadius: radius.lg }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Tile icon={icon} tile={tile} />
        <Text style={{ fontSize: 28, fontWeight: "700", color: value ? colors.fg : colors.subtle, fontVariant: ["tabular-nums"] }}>{value}</Text>
      </View>
      <Text style={[font.small, { color: colors.muted }]} numberOfLines={1}>{label}</Text>
    </PressableCard>
  );
}
