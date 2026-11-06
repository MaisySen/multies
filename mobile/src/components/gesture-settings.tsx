import { useState } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import { tl, tr } from "@/i18n";
import { ActionSheet } from "./action-sheet";
import { Row, SectionTitle } from "./ui";
import { MAIL_SWIPE_CHOICES, SWIPE_SLOTS, TASK_SWIPE_CHOICES, setPrefs, usePrefs, type MailSwipe, type SwipeSet, type TaskSwipe } from "@/lib/prefs";
import { tick } from "@/lib/haptics";
import { colors, space } from "@/theme";

type Slot = keyof SwipeSet<string>;
type Picking = { list: "mail" | "tasks"; slot: Slot } | null;

/** R33: Settings rows for Haptics and the four swipe actions on mail and on tasks. */
export function GestureSettings() {
  const prefs = usePrefs();
  const [picking, setPicking] = useState<Picking>(null);
  const L = (en: string) => tl("m.swipe", en);
  const label = (list: "mail" | "tasks", id: string) => L((list === "mail" ? MAIL_SWIPE_CHOICES : TASK_SWIPE_CHOICES).find((c) => c.id === id)?.label ?? "None");
  const choices = picking?.list === "mail" ? MAIL_SWIPE_CHOICES : TASK_SWIPE_CHOICES;
  const current = picking ? (picking.list === "mail" ? prefs.mailSwipes : prefs.taskSwipes)[picking.slot] : null;
  const slotLabel = L(SWIPE_SLOTS.find((s) => s.id === picking?.slot)?.label ?? "");

  const pick = (id: string) => {
    if (!picking) return;
    if (picking.list === "mail") setPrefs({ mailSwipes: { ...prefs.mailSwipes, [picking.slot]: id as MailSwipe } });
    else setPrefs({ taskSwipes: { ...prefs.taskSwipes, [picking.slot]: id as TaskSwipe } });
    setPicking(null);
    tick();
  };

  return (
    <>
      {/* MPAR2 (MB-362): the whole row toggles, so the target is the row, not only the switch. */}
      <Pressable onPress={() => { const v = !prefs.haptics; setPrefs({ haptics: v }); if (v) tick(); }} accessibilityRole="switch" accessibilityState={{ checked: prefs.haptics }}
        accessibilityLabel={tr("m.swipe.haptics")} style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: space.lg, minHeight: 52, gap: space.md }} testID="haptics-setting">
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: colors.fg, fontSize: 16 }} nativeID="haptics-label">{tr("m.swipe.haptics")}</Text>
          <Text style={{ color: colors.subtle, fontSize: 13 }}>{tr("m.swipe.haptics_note")}</Text>
        </View>
        <Switch value={prefs.haptics} onValueChange={(v) => { setPrefs({ haptics: v }); if (v) tick(); }} accessibilityLabel={tr("m.swipe.haptics")} aria-labelledby="haptics-label"
          accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
          trackColor={{ true: colors.brandFill, false: colors.elevated }} testID="haptics-switch" />
      </Pressable>

      <SectionTitle>{tr("m.swipe.on_mail")}</SectionTitle>
      {SWIPE_SLOTS.map((s) => (
        <Row key={`mail-${s.id}`} icon={s.id.startsWith("right") ? "corner-up-right" : "corner-up-left"} label={L(s.label)} value={label("mail", prefs.mailSwipes[s.id])}
          onPress={() => setPicking({ list: "mail", slot: s.id })} testID={`swipe-mail-${s.id}`} />
      ))}
      <SectionTitle>{tr("m.swipe.on_tasks")}</SectionTitle>
      {SWIPE_SLOTS.map((s) => (
        <Row key={`tasks-${s.id}`} icon={s.id.startsWith("right") ? "corner-up-right" : "corner-up-left"} label={L(s.label)} value={label("tasks", prefs.taskSwipes[s.id])}
          onPress={() => setPicking({ list: "tasks", slot: s.id })} testID={`swipe-tasks-${s.id}`} />
      ))}
      <Text style={{ color: colors.subtle, fontSize: 13, marginHorizontal: space.lg, marginTop: space.xs }}>{tr("m.swipe.long_note")}</Text>

      <ActionSheet visible={!!picking} title={slotLabel} subtitle={picking?.list === "mail" ? tr("m.swipe.mail") : tr("m.swipe.tasks")} testID="swipe-picker"
        options={choices.map((c) => ({ id: c.id, label: L(c.label), selected: c.id === current }))} onSelect={pick} onClose={() => setPicking(null)} />
    </>
  );
}
