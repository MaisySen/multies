import { useState } from "react";
import { Alert, Platform, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { ScreenHeader, Problem } from "@/components/m3-ui";
import { Button, Field, IconButton, Loading } from "@/components/ui";
import { InsetGroup, GroupRow } from "@/components/grouped";
import { Note, Sheet } from "@/components/mpar3-ui";
import { colors, font, space } from "@/theme";
import { tr } from "@/i18n";
import { success, tick, warning } from "@/lib/haptics";
import { flagOn, useWebConfig } from "@/lib/web-config";
import { icsProblem, type CalendarSource } from "@/lib/mpar3";
import { useCalendarActions, useCalendarFeed, useCalendarSources } from "@/lib/mpar3-queries";

/**
 * MPAR3: Calendar settings, as on the web's Settings, Calendar: other calendars shown in Multies (switch on or off,
 * add one by its private link, remove), and the private feed that puts Multies meetings and due dates into another
 * calendar app. A new feed link is shown once; Multies keeps only its last characters.
 */
function confirm(title: string, body: string, ok: string, run: () => void) {
  if (Platform.OS === "web") { if (globalThis.confirm?.(`${title}\n${body}`) ?? true) run(); return; }
  Alert.alert(title, body, [{ text: tr("common.cancel"), style: "cancel" }, { text: ok, style: "destructive", onPress: run }]);
}

export default function CalendarSettings() {
  const sources = useCalendarSources();
  const feed = useCalendarFeed();
  const act = useCalendarActions();
  const web = useWebConfig();
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const add = async () => {
    const bad = icsProblem(url);
    if (bad) return setErr(bad);
    setErr(null);
    try { await act.addIcs.mutateAsync({ url, name }); success(); setAdding(false); setUrl(""); setName(""); }
    catch (x) { warning(); setErr((x as Error).message || tr("m.cal.save_failed")); }
  };
  const makeLink = async () => {
    try { const r = await act.resetFeed.mutateAsync(feed.data?.includeTasks ?? true); setLink(r.feed.url ?? null); setCopied(false); success(); }
    catch (x) { warning(); setErr((x as Error).message); }
  };
  const copy = async () => { if (!link) return; tick(); await Clipboard.setStringAsync(link); setCopied(true); success(); };
  const remove = (s: CalendarSource) => confirm(tr("m.calset.remove_title", { name: s.name }), tr("m.calset.remove_body"), tr("common.remove"), () => act.removeSource.mutate(s.id));

  const loading = sources.isLoading || feed.isLoading;
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="calendar-settings-screen">
      <ScreenHeader title={tr("m.calset.title")} back={tr("common.back")} />
      {loading ? <Loading label={tr("m.cal.loading")} rows={4} variant="task" /> : sources.error && !sources.data ? <Problem q={sources} what={tr("m.calset.title")} testID="calset-problem" /> : (
        <ScrollView contentContainerStyle={{ paddingVertical: space.lg, paddingBottom: space.xxl }}>
          <InsetGroup header={tr("m.calset.other_header")} footer={tr("m.calset.other_footer")} testID="calset-sources">
            {(sources.data ?? []).map((s) => (
              <GroupRow key={s.id} label={s.name} sub={s.host ?? (s.kind === "caldav" ? s.address ?? tr("m.calset.caldav") : undefined)} testID={`source-${s.id}`}
                toggle={{ value: s.enabled, onChange: (v) => act.toggleSource.mutate({ id: s.id, enabled: v }) }}
                right={<View style={{ flexDirection: "row", alignItems: "center" }}>
                  <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: s.color, marginRight: 2 }} accessibilityElementsHidden importantForAccessibility="no" />
                  <IconButton icon="trash-2" label={tr("m.calset.remove_named", { name: s.name })} color={colors.muted} onPress={() => remove(s)} testID={`source-remove-${s.id}`} />
                </View>} />
            ))}
            {!(sources.data ?? []).length ? <GroupRow label={tr("m.calset.none")} /> : null}
            <GroupRow icon="plus" tile="blue" label={tr("m.calset.add_link")} onPress={() => { tick(); setErr(null); setAdding(true); }} testID="calset-add" chevron />
          </InsetGroup>
          <InsetGroup header={tr("m.calset.feed_header")} footer={tr("m.calset.feed_footer")} testID="calset-feed">
            <GroupRow label={tr("m.calset.feed_status")} value={feed.data?.enabled ? tr("m.calset.feed_on", { hint: feed.data.hint ?? "" }) : tr("m.calset.feed_off")} />
            <GroupRow label={tr("m.calset.include_tasks")} testID="calset-tasks" toggle={{ value: feed.data?.includeTasks ?? true, disabled: !feed.data?.enabled, onChange: (v) => act.feedTasks.mutate(v) }} />
            <GroupRow icon="link" tile="green" label={feed.data?.enabled ? tr("m.calset.new_link") : tr("m.calset.make_link")} onPress={makeLink} testID="calset-make" chevron />
            {feed.data?.enabled ? <GroupRow icon="x" tile="red" label={tr("m.calset.stop_feed")} destructive testID="calset-stop"
              onPress={() => confirm(tr("m.calset.stop_feed"), tr("m.calset.stop_body"), tr("m.calset.stop_ok"), () => { setLink(null); act.stopFeed.mutate(); })} /> : null}
          </InsetGroup>
          {link ? (
            <View style={{ marginHorizontal: space.lg, marginBottom: space.lg, padding: space.lg, gap: space.sm, backgroundColor: colors.surface, borderRadius: 14 }} testID="calset-link">
              <Text style={font.headline}>{tr("m.calset.link_title")}</Text>
              <Text selectable style={[font.small, { color: colors.fg }]} numberOfLines={3}>{link}</Text>
              <Note>{tr("m.calset.link_note")}</Note>
              <Button label={copied ? tr("m.calset.copied") : tr("m.calset.copy")} icon={copied ? "check" : "copy"} variant="secondary" onPress={copy} testID="calset-copy" />
            </View>
          ) : null}
          {flagOn(web.data, "davSync") ? (
            <InsetGroup footer={tr("m.calset.sync_footer")}>
              <GroupRow icon="smartphone" tile="teal" label={tr("m.settings.calendar_and_contacts_sync")} onPress={() => router.push("/sync")} chevron testID="calset-sync" />
            </InsetGroup>
          ) : null}
          {err && !adding ? <View style={{ paddingHorizontal: space.lg }}><Note tone="bad">{err}</Note></View> : null}
        </ScrollView>
      )}
      <Sheet visible={adding} onClose={() => setAdding(false)} title={tr("m.calset.add_link")} subtitle={tr("m.calset.add_sub")} testID="calset-add-sheet"
        footer={<Button label={tr("m.calset.add_ok")} onPress={add} loading={act.addIcs.isPending} testID="calset-add-save" />}>
        <Field label={tr("m.calset.link_label")} value={url} onChangeText={setUrl} autoCapitalize="none" keyboardType="url" placeholder="https://" testID="calset-url" />
        <Field label={tr("m.calset.name_label")} value={name} onChangeText={setName} placeholder={tr("m.calset.name_placeholder")} testID="calset-name" />
        <Note>{tr("m.calset.private_note")}</Note>
        {err ? <Note tone="bad">{err}</Note> : null}
      </Sheet>
    </View>
  );
}
