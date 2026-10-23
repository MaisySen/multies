import { Alert, Platform, Text, View } from "react-native";
import { Badge, Button, Card } from "@/components/ui";
import { useCreateMeeting } from "@/lib/queries";
import { copyGuestLink, isLive, meetingWhen, openMeeting } from "@/lib/meetings";
import type { Meeting, MeetingSource } from "@/api/types";
import { colors, font, space } from "@/theme";

function say(title: string, body?: string) {
  if (Platform.OS === "web") globalThis.alert?.(body ? `${title}\n${body}` : title);
  else Alert.alert(title, body);
}

/** Starts a meeting now, linked to this task, thread or contact, and opens it. */
export function StartMeetingButton({ source, title, testID = "start-meeting" }: { source?: MeetingSource; title?: string; testID?: string }) {
  const create = useCreateMeeting();
  const start = async () => {
    try {
      const m = await create.mutateAsync({ source, title });
      await openMeeting(m.joinUrl);
    } catch (e) {
      say("The meeting didn't start", (e as Error).message);
    }
  };
  return <Button variant="secondary" icon="video" label="Start meeting" onPress={start} loading={create.isPending} testID={testID} />;
}

export function MeetingCard({ m, now }: { m: Meeting; now: number }) {
  const copy = () => copyGuestLink(m).then(() => say("Guest link copied", "Anyone with it can join from a browser, no account needed."))
    .catch((e: Error) => say("Couldn't copy the link", e.message));
  const live = isLive(m, now);
  return (
    <Card style={{ gap: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Text style={{ color: colors.fg, fontWeight: "700", fontSize: 16, flex: 1 }} numberOfLines={2}>{m.title}</Text>
        {live ? <Badge label="Now" tone="brand" /> : null}
      </View>
      <Text style={font.small}>{meetingWhen(m)}</Text>
      {m.invitees.length ? <Text style={font.tiny} numberOfLines={1}>With {m.invitees.join(", ")}</Text> : null}
      <View style={{ flexDirection: "row", gap: space.sm }}>
        <Button label="Join" icon="video" onPress={() => openMeeting(m.joinUrl)} style={{ flex: 1 }} testID={`join-${m.id}`} />
        <Button label="Copy guest link" icon="link" variant="secondary" onPress={copy} style={{ flex: 1.4 }} testID={`copy-${m.id}`} />
      </View>
    </Card>
  );
}
