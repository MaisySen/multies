import { Alert, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useOffline } from "@/lib/offline";
import { blockOffline } from "@/lib/command-queue";
import { Badge, Button, Icon, TILE } from "@/components/ui";
import { success, tick, warning } from "@/lib/haptics";
import { useCreateMeeting } from "@/lib/queries";
import { copyGuestLink, isLive, meetingTime, meetingWhen, openMeeting } from "@/lib/meetings";
import type { Meeting, MeetingSource } from "@/api/types";
import { colors, shadow, space } from "@/theme";

function say(title: string, body?: string) {
  if (Platform.OS === "web") globalThis.alert?.(body ? `${title}\n${body}` : title);
  else Alert.alert(title, body);
}

/** Starts a meeting now, linked to this task, thread or contact, and opens it. */
export function StartMeetingButton({ source, title, testID = "start-meeting" }: { source?: MeetingSource; title?: string; testID?: string }) {
  const create = useCreateMeeting();
  const offline = useOffline();
  const start = async () => {
    if (blockOffline(offline)) return; // R33: a meeting needs the server
    try {
      const m = await create.mutateAsync({ source, title });
      await openMeeting(m.joinUrl);
    } catch (e) {
      say("The meeting didn't start", (e as Error).message);
    }
  };
  return <Button variant="secondary" icon="video" label="Start meeting" onPress={start} loading={create.isPending} testID={testID} />;
}

/** R36: an event row with a colour bar, the time in a fixed column, and Join plus Copy guest link. */
export function MeetingCard({ m, now }: { m: Meeting; now: number }) {
  const copy = () => { tick(); copyGuestLink(m).then(() => { success(); say("Guest link copied", "Anyone with it can join from a browser, no account needed."); })
    .catch((e: Error) => { warning(); say("Couldn't copy the link", e.message); }); };
  const live = isLive(m, now);
  const bar = live ? colors.brandFill : TILE.teal;
  return (
    <View style={{ flexDirection: "row", backgroundColor: colors.surface, borderRadius: 12, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, borderColor: live ? colors.brandLine : colors.line, ...shadow }}
      accessible={false} testID={`meeting-${m.id}`}>
      <View style={{ width: 4, backgroundColor: bar }} />
      <View style={{ width: 72, paddingVertical: space.md, paddingLeft: space.md, gap: 2 }}>
        <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{meetingTime(m.startsAt)}</Text>
        <Text style={{ color: colors.subtle, fontSize: 13 }}>{m.durationMin} min</Text>
      </View>
      <View style={{ flex: 1, paddingVertical: space.md, paddingRight: space.md, gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Text style={{ color: colors.fg, fontWeight: "600", fontSize: 16, flex: 1, letterSpacing: -0.3 }} numberOfLines={2} accessibilityLabel={`${m.title}, ${meetingWhen(m)}`}>{m.title}</Text>
          {live ? <Badge label="Now" tone="brand" /> : null}
        </View>
        {m.invitees.length ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Icon name="users" size={14} color={colors.subtle} />
            <Text style={{ color: colors.muted, fontSize: 13, flex: 1 }} numberOfLines={1}>{m.invitees.join(", ")}</Text>
          </View>
        ) : null}
        <View style={{ flexDirection: "row", gap: space.sm, marginTop: 2 }}>
          <Pressable onPress={() => { tick(); openMeeting(m.joinUrl); }} testID={`join-${m.id}`} accessibilityRole="button" accessibilityLabel={`Join ${m.title}`}
            style={({ pressed }) => [chip, { backgroundColor: live ? colors.brandFill : colors.brandSoft }, pressed && { opacity: 0.7 }]}>
            <Icon name="video" size={16} color={live ? colors.brandFg : colors.brand} />
            <Text style={{ color: live ? colors.brandFg : colors.brand, fontWeight: "600", fontSize: 14 }}>Join</Text>
          </Pressable>
          <Pressable onPress={copy} testID={`copy-${m.id}`} accessibilityRole="button" accessibilityLabel="Copy guest link"
            style={({ pressed }) => [chip, { backgroundColor: colors.neutralSoft }, pressed && { opacity: 0.7 }]}>
            <Icon name="link" size={16} color={colors.fg} />
            <Text style={{ color: colors.fg, fontWeight: "500", fontSize: 14 }}>Copy guest link</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const chip = { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, height: 34, paddingHorizontal: 12, borderRadius: 17 };
