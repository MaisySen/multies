import type { ReactNode } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import type { MessageSummary } from "@/api/types";
import { Avatar, Badge, Icon, LargeTitle, PressableCard, TILE, type IconName, type TileColor } from "@/components/ui";
import { useCollapse } from "@/components/chrome";
import { NotificationBell } from "@/components/notification-bell";
import { useBadges } from "@/lib/use-badges";
import { useMeetings, useMessages, useTasks } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { useInboxBadge, useSocialPosts, useSocialStatus } from "@/lib/social-queries";
import { badgeText } from "@/lib/social-inbox";
import { socialSummary } from "@/lib/social";
import { dayFrom } from "@/lib/tasks";
import { daySummary, focusTasks, greeting, nextMeeting, topUnread, whenLabel } from "@/lib/today";
import { displayName, shortDate } from "@/lib/format";
import { groupCount, statCount } from "@/lib/numbers";
import { tick } from "@/lib/haptics";
import { HeroAction, Hero, SectionHeader, TintIcon, m4s } from "@/components/m4-ui";
import { FEATURES } from "@/config";
import { shotFixture } from "@/lib/shot-fixture";
import { colors, font, radius, space } from "@/theme";

/**
 * R34: the Today home. M5 (1.10.13): one glance, nothing twice. The hero says what the day holds (tasks and the next
 * meeting) with three even quick actions; four stat tiles carry the counts (grouped, never cut off); then the newest
 * unread mail, what is due, the next meeting and Social, each with a way to see all. Counts come from GET /api/counts.
 */
export default function Today() {
  const insets = useSafeAreaInsets();
  const { me } = useSession();
  const b = useBadges();
  const meetings = useMeetings();
  const mine = useTasks({ assignee: "me" });
  const inbox = useMessages("inbox");
  const qc = useQueryClient();
  const collapse = useCollapse();
  const now = new Date();
  const next = nextMeeting(meetings.data?.meetings, now);
  const focus = FEATURES.tasks ? focusTasks(mine.data, dayFrom(0, now)) : [];
  const first = (shotFixture()?.name ?? me?.user.name)?.split(" ")[0];
  const unreadMail = topUnread(inbox.data?.pages?.[0]?.messages, b.inbox ? 3 : 0);
  // 1.10.6: a Social card when posting is on for this workspace: the newest post, or how many need a look.
  const socialOn = useSocialStatus();
  const posts = useSocialPosts(!!socialOn.data?.available);
  const social = socialOn.data?.available ? socialSummary(posts.data) : null;
  // 1.10.8: open conversations in the Social inbox, as a badge on the card (quiet where the inbox is off).
  const inboxOpen = badgeText(useInboxBadge(!!socialOn.data?.available).data);
  const date = now.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" });
  const go = (path: string) => { tick(); router.push(path as never); };
  const when = next ? whenLabel(next.startsAt, now) : null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <LargeTitle title="Today" subtitle={date} top={insets.top} collapsed={collapse.collapsed} right={<NotificationBell />} />
      <ScrollView {...collapse.scrollProps} contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.md, paddingBottom: space.xxl * 3 }} testID="today"
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => { qc.invalidateQueries(); }} tintColor={colors.brand} />}>
        <Hero testID="today-hero" title={first ? `${greeting(now)}, ${first}` : greeting(now)}
          subtitle={daySummary(FEATURES.tasks ? b.tasks : 0, next ? `${next.title} ${when}` : null)}>
          <HeroAction icon="compose" label="Write" onPress={() => go("/compose")} testID="today-compose" />
          {FEATURES.tasks ? <HeroAction icon="tasks" label="My tasks" onPress={() => go("/tasks")} testID="today-mytasks" /> : null}
          <HeroAction icon="search" label="Search" onPress={() => go("/search")} testID="today-search" />
        </Hero>

        <View style={{ flexDirection: "row", gap: space.md }}>
          <Stat testID="today-mail" icon="inbox" tile="blue" value={b.inbox} label="Unread mail" onPress={() => go("/inbox")} />
          {FEATURES.tasks ? <Stat testID="today-tasks" icon="tasks" tile="orange" value={b.tasks} label="Due or overdue" onPress={() => go("/tasks")} />
            : <Stat testID="today-tasks" icon="approvals" tile="green" value={b.approvals} label="Approvals waiting" onPress={() => go("/review")} />}
        </View>
        <View style={{ flexDirection: "row", gap: space.md }}>
          <Stat testID="today-mentions" icon="mention" tile="purple" value={b.mentions} label={b.mentions === 1 ? "Mention" : "Mentions"} onPress={() => go("/chat")} />
          {FEATURES.tasks ? <Stat testID="today-approvals" icon="approvals" tile="green" value={b.approvals} label="Approvals waiting" onPress={() => go("/review")} />
            : <Stat testID="today-chat" icon="chat" tile="indigo" value={b.chat} label="Unread chat" onPress={() => go("/chat")} />}
        </View>

        <SectionHeader title="Unread mail" action={b.inbox ? "See all" : undefined} onAction={() => go("/inbox")} testID="today-unread-header" />
        <View style={m4s.card} testID="today-unread">
          {unreadMail.length ? unreadMail.map((m, i) => (
            <MailLine key={m.id} m={m} last={i === unreadMail.length - 1} now={now} onPress={() => go(`/thread/${m.id}`)} />
          )) : (
            b.inbox ? <QuietLine icon="inbox" tone="brand" text={`${groupCount(b.inbox)} unread in your inbox`} onPress={() => go("/inbox")} />
            : <QuietLine icon="check" text="You're all caught up on mail" />
          )}
        </View>

        {FEATURES.tasks ? (
          <>
            <SectionHeader title="Due today" action={b.tasks ? "See all" : undefined} onAction={() => go("/tasks")} testID="today-focus-header" />
            <View style={m4s.card} testID="today-focus">
              {focus.length ? focus.map((t, i) => {
                const late = t.due!.slice(0, 10) < dayFrom(0, now);
                return (
                  <PressRow key={t.id} last={i === focus.length - 1} onPress={() => go(`/task/${t.id}`)} label={`${t.title}, ${late ? "overdue" : "due today"}`}>
                    <Icon name={late ? "overdue" : "due"} size={20} color={late ? colors.bad : colors.brand} filled />
                    <Text style={[font.body, { flex: 1 }]} numberOfLines={2}>{t.title}</Text>
                    <Text style={{ color: late ? colors.bad : colors.subtle, fontSize: 13, fontWeight: "600" }}>{late ? "Overdue" : "Today"}</Text>
                  </PressRow>
                );
              }) : b.tasks ? <QuietLine icon="tasks" tone="brand" text={`${groupCount(b.tasks)} due or overdue in Tasks`} onPress={() => go("/tasks")} />
                : <QuietLine icon="check" text="Nothing due today" />}
            </View>
          </>
        ) : null}

        <SectionHeader title="Coming up" />
        <PressableCard onPress={() => go("/meetings")} testID="today-meeting" accessibilityRole="button"
          accessibilityLabel={next ? `Next meeting, ${next.title}, ${when}` : "No meetings coming up"} style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
          <Tile icon="video" tile="teal" />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={font.headline} numberOfLines={2}>{next ? next.title : "No meetings coming up"}</Text>
            <Text style={[font.small, next ? { color: colors.brand, fontWeight: "600" } : null]} numberOfLines={1}>{next ? when : "Your calendar is clear"}</Text>
          </View>
          <Icon name="chevron-right" size={18} color={colors.subtle} />
        </PressableCard>

        {social ? (
          <PressableCard onPress={() => go(inboxOpen && !social.failed ? "/social?tab=inbox" : "/social")} testID="today-social" accessibilityRole="button"
            accessibilityLabel={`Social, ${social.title}${social.detail ? `, ${social.detail}` : ""}${inboxOpen ? `, ${inboxOpen} open in the inbox` : ""}`} style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
            <Tile icon="send" tile="pink" />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={font.tiny}>Social</Text>
              <Text style={font.headline} numberOfLines={1}>{social.title}</Text>
              {social.detail ? <Text style={[font.tiny, { color: colors.subtle }]} numberOfLines={1}>{social.detail}</Text> : null}
              {inboxOpen && social.failed ? <Text style={[font.tiny, { color: colors.subtle }]} numberOfLines={1} testID="today-social-inbox">{inboxOpen} open in the inbox</Text> : null}
            </View>
            {social.failed ? <Badge label={`${social.failed} failed`} tone="bad" /> : inboxOpen ? <Badge label={`${inboxOpen} to answer`} tone="brand" icon="inbox" /> : <Icon name="chevron-right" size={18} color={colors.subtle} />}
          </PressableCard>
        ) : null}
      </ScrollView>
    </View>
  );
}

function Tile({ icon, tile }: { icon: IconName; tile: TileColor }) {
  return <TintIcon icon={icon} color={TILE[tile]} size={40} />;
}

function Stat({ icon, tile, value, label, onPress, testID }: { icon: IconName; tile: TileColor; value: number; label: string; onPress: () => void; testID: string }) {
  return (
    <PressableCard onPress={onPress} testID={testID} accessibilityRole="button" accessibilityLabel={`${label}, ${groupCount(value)}`}
      style={{ flex: 1, flexBasis: 0, gap: space.sm, borderRadius: radius.lg, padding: space.lg }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Tile icon={icon} tile={tile} />
        <Icon name="chevron-right" size={16} color={colors.subtle} />
      </View>
      <Text style={{ fontSize: 28, lineHeight: 34, fontWeight: "700", letterSpacing: 0.2, color: value ? colors.fg : colors.subtle, fontVariant: ["tabular-nums"] }}
        numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} maxFontSizeMultiplier={1.3} testID={`${testID}-value`}>{statCount(value)}</Text>
      <Text style={[font.small, { color: colors.muted }]} numberOfLines={1} maxFontSizeMultiplier={1.5}>{label}</Text>
    </PressableCard>
  );
}

function PressRow({ children, onPress, label, last }: { children: ReactNode; onPress: () => void; label: string; last: boolean }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label}
      style={({ pressed }) => [m4s.row, !last && m4s.sep, pressed && { backgroundColor: colors.hover }]}>{children}</Pressable>
  );
}

function MailLine({ m, onPress, last, now }: { m: MessageSummary; onPress: () => void; last: boolean; now: Date }) {
  const who = displayName(m.from);
  return (
    <PressRow onPress={onPress} last={last} label={`Unread from ${who}, ${m.subject || "No subject"}`}>
      <Avatar name={who} size={36} />
      <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
          <Text style={[font.headline, { flex: 1 }]} numberOfLines={1}>{who}</Text>
          <Text style={[font.tiny, { fontVariant: ["tabular-nums"] }]}>{shortDate(m.date, now)}</Text>
        </View>
        <Text style={[font.small, { color: colors.fg }]} numberOfLines={1}>{m.subject || "No subject"}</Text>
      </View>
    </PressRow>
  );
}

/** A one line card body for a calm state ("You're all caught up on mail") or a pointer to the full list. */
function QuietLine({ icon, text, tone = "ok", onPress }: { icon: IconName; text: string; tone?: "ok" | "brand"; onPress?: () => void }) {
  const body = (
    <>
      <TintIcon icon={icon} color={tone === "ok" ? colors.ok : colors.brand} size={28} />
      <Text style={[font.small, { flex: 1, color: colors.fg }]}>{text}</Text>
      {onPress ? <Icon name="chevron-right" size={16} color={colors.subtle} /> : null}
    </>
  );
  return onPress ? (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={text} style={({ pressed }) => [m4s.row, { minHeight: 56 }, pressed && { backgroundColor: colors.hover }]}>{body}</Pressable>
  ) : (
    <View style={[m4s.row, { minHeight: 56 }]} accessible accessibilityLabel={text}>{body}</View>
  );
}
