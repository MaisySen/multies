import { useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { ScreenHeader, Problem } from "@/components/m3-ui";
import { Badge, Button, EmptyState, Icon, Loading } from "@/components/ui";
import { colors, font, lh, radius, space, TOUCH } from "@/theme";
import { currentLocale, tr } from "@/i18n";
import { tick } from "@/lib/haptics";
import { openMeeting } from "@/lib/meetings";
import { openWeb } from "@/lib/web-open";
import { durationText, transcriptLines, type MeetingRecording } from "@/lib/mpar3";
import { isOff, useMeetingNotes, useMeetingRecordings } from "@/lib/mpar3-queries";

/**
 * MPAR3: a meeting's notes, minutes and transcripts, readable on the phone (GET /api/meeting-notes/:id and
 * GET /api/meetings/:id/recordings). Writing the notes and recording stay on the web page for now; the full notes
 * doc opens there in the in-app browser.
 */
export default function MeetingNotesScreen() {
  const { id = "" } = useLocalSearchParams<{ id: string }>();
  const q = useMeetingNotes(id);
  const rec = useMeetingRecordings(id);
  const n = q.data;
  const when = n ? new Date(n.meeting.startsAt).toLocaleString(currentLocale(), { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";
  const recordings = (rec.data ?? []).filter((r) => r.transcript || r.summary);
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="meeting-notes-screen">
      <ScreenHeader title={tr("m.notes.title")} back={tr("common.back")} />
      {q.isLoading ? <Loading label={tr("m.notes.loading")} rows={5} variant="task" /> : q.error && !n ? (isOff(q.error)
        ? <EmptyState icon="file-text" title={tr("m.notes.off_title")} body={tr("m.notes.off_body")} />
        : <Problem q={q} what={tr("m.notes.title")} testID="notes-problem" />) : n ? (
        <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xxl }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { void q.refetch(); void rec.refetch(); }} />}>
          <View style={{ gap: 4 }}>
            <Text style={font.heading} accessibilityRole="header" testID="notes-meeting-title">{n.meeting.title}</Text>
            <Text style={font.small}>{when}{n.meeting.recurrence ? ` · ${n.meeting.recurrence}` : ""}</Text>
            {n.meeting.invitees.length ? <Text style={[font.small, { color: colors.subtle }]} numberOfLines={2}>{n.meeting.invitees.join(", ")}</Text> : null}
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            {n.meeting.status !== "ended" && n.meeting.status !== "cancelled" ? <Button icon="video" label={tr("m.cal.join")} onPress={() => { tick(); void openMeeting(n.meeting.joinUrl); }} testID="notes-join" /> : null}
            <Button icon="external-link" variant="secondary" label={tr("m.notes.edit_on_web")} onPress={() => { tick(); void openWeb(`/app/meetings/${n.meeting.id}`); }} testID="notes-web" />
          </View>
          {n.summary ? (
            <Section title={tr("m.notes.minutes")} icon="sparkle" testID="notes-summary">
              <Text style={st.body} selectable>{n.summary}</Text>
              {n.summaryActionItems.length ? n.summaryActionItems.map((a, i) => <Bullet key={i} text={a.text} meta={[a.assignee, a.due].filter(Boolean).join(", ")} />) : null}
            </Section>
          ) : null}
          <Section title={tr("m.notes.agenda")} icon="list" testID="notes-agenda">
            {n.agenda.length ? n.agenda.map((a, i) => <Bullet key={i} text={a} />) : <Text style={font.small}>{tr("m.notes.no_agenda")}</Text>}
          </Section>
          <Section title={tr("m.notes.notes")} icon="file-text" testID="notes-notes">
            {n.notes.length ? n.notes.map((a, i) => <Bullet key={i} text={a} />) : <Text style={font.small}>{tr("m.notes.no_notes")}</Text>}
          </Section>
          <Section title={tr("m.notes.actions")} icon="check-square" testID="notes-actions">
            {n.actionItems.length ? n.actionItems.map((a) => (
              <Pressable key={a.key} disabled={!a.task} onPress={() => { if (a.task) { tick(); router.push(`/task/${a.task.id}`); } }} accessibilityRole={a.task ? "button" : undefined}
                accessibilityLabel={a.task ? tr("m.notes.open_task_named", { name: a.title }) : a.title}
                style={({ pressed }) => [st.action, pressed && { backgroundColor: colors.hover }]} testID={`notes-item-${a.key}`}>
                <Icon name={a.task?.done ? "check-circle" : "circle"} size={20} color={a.task?.done ? colors.ok : colors.subtle} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={st.body}>{a.title || a.text}</Text>
                  {a.assignee || a.due ? <Text style={st.meta}>{[a.assignee, a.due].filter(Boolean).join(", ")}</Text> : null}
                </View>
                {a.task ? <Badge label={a.task.ref} tone="brand" /> : null}
              </Pressable>
            )) : <Text style={font.small}>{tr("m.notes.no_actions")}</Text>}
          </Section>
          <Section title={tr("m.notes.transcripts")} icon="message-square" testID="notes-transcripts">
            {rec.isLoading ? <Text style={font.small}>{tr("m.notes.loading")}</Text> : recordings.length ? recordings.map((r) => <Transcript key={r.id} r={r} />)
              : <Text style={font.small}>{rec.error && isOff(rec.error) ? tr("m.notes.no_recording_access") : tr("m.notes.no_transcripts")}</Text>}
            <Text style={[font.tiny, { lineHeight: lh(17) }]}>{tr("m.notes.record_note")}</Text>
          </Section>
        </ScrollView>
      ) : null}
    </View>
  );
}

function Section({ title, icon, children, testID }: { title: string; icon: "list" | "file-text" | "check-square" | "message-square" | "sparkle"; children: React.ReactNode; testID?: string }) {
  return (
    <View style={st.card} testID={testID}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Icon name={icon} size={18} color={colors.brand} />
        <Text style={font.headline} accessibilityRole="header">{title}</Text>
      </View>
      {children}
    </View>
  );
}

function Bullet({ text, meta }: { text: string; meta?: string }) {
  return (
    <View style={{ flexDirection: "row", gap: space.sm }}>
      <Text style={[st.body, { color: colors.subtle }]} accessibilityElementsHidden importantForAccessibility="no">•</Text>
      <View style={{ flex: 1 }}>
        <Text style={st.body} selectable>{text}</Text>
        {meta ? <Text style={st.meta}>{meta}</Text> : null}
      </View>
    </View>
  );
}

function Transcript({ r }: { r: MeetingRecording }) {
  const [open, setOpen] = useState(false);
  const lines = transcriptLines(r.transcript);
  const shown = open ? lines : lines.slice(0, 3);
  const started = new Date(r.startedAt).toLocaleString(currentLocale(), { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  return (
    <View style={st.rec} testID={`transcript-${r.id}`}>
      <Text style={st.meta}>{tr("m.notes.recorded_by", { name: r.startedBy.name, when: started })}{r.durationSec ? `, ${durationText(r.durationSec)}` : ""}</Text>
      {r.summary ? <Text style={st.body} selectable>{r.summary}</Text> : null}
      {shown.map((l, i) => (
        <View key={i} style={{ flexDirection: "row", gap: space.sm }}>
          {l.at ? <Text style={[st.meta, { width: 48, fontVariant: ["tabular-nums"] }]}>{l.at}</Text> : null}
          <Text style={[st.body, { flex: 1 }]} selectable>{l.text}</Text>
        </View>
      ))}
      {r.truncated && open ? <Text style={st.meta}>{tr("m.notes.truncated")}</Text> : null}
      {lines.length > 3 ? (
        <Pressable onPress={() => { tick(); setOpen((v) => !v); }} accessibilityRole="button" accessibilityState={{ expanded: open }} testID={`transcript-more-${r.id}`}
          style={({ pressed }) => [st.more, pressed && { opacity: 0.7 }]}>
          <Text style={{ color: colors.brand, fontWeight: "600", fontSize: 15, lineHeight: lh(20) }}>{open ? tr("m.notes.show_less") : tr("m.notes.show_all", { count: lines.length })}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const st = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: 14, padding: space.lg, gap: space.md },
  body: { color: colors.fg, fontSize: 16, lineHeight: lh(23) },
  meta: { color: colors.subtle, fontSize: 13, lineHeight: lh(18) },
  action: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TOUCH, borderRadius: radius.md, paddingVertical: 4 },
  rec: { gap: space.sm, paddingTop: space.xs },
  more: { minHeight: TOUCH, justifyContent: "center", alignSelf: "flex-start" },
});
