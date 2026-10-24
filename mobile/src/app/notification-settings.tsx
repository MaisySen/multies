import { ScrollView, Switch, Text, View } from "react-native";
import { Banner, Button, EmptyState, Loading } from "@/components/ui";
import { useNotificationSettings, useSaveNotificationSetting } from "@/lib/queries";
import { CATEGORY_LABELS, orderedCategories } from "@/lib/notifications";
import { colors, font, space } from "@/theme";

/** Per category: show it in the inbox, and send a push to this phone. */
export default function NotificationSettings() {
  const q = useNotificationSettings();
  const save = useSaveNotificationSetting();
  if (q.isPending) return <Loading />;
  if (q.error) return <EmptyState icon="alert-circle" title="Couldn't load your settings" body={q.error.message} action={<Button label="Try again" variant="secondary" onPress={() => q.refetch()} />} />;
  const s = q.data;
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: space.xxl * 2 }} testID="notification-settings">
      {save.error ? <Banner tone="bad" icon="alert-circle" text={`Couldn't save: ${save.error.message}`} /> : null}
      <Text style={[font.small, { margin: space.lg }]}>Choose what shows in your notifications inbox and what also comes to this phone as a push. Push also needs notifications allowed in Settings.</Text>
      <View style={{ flexDirection: "row", paddingHorizontal: space.lg, paddingBottom: space.sm }}>
        <Text style={[font.tiny, { flex: 1 }]}>CATEGORY</Text>
        <Text style={[font.tiny, { width: 64, textAlign: "center" }]}>IN APP</Text>
        <Text style={[font.tiny, { width: 64, textAlign: "center" }]}>PUSH</Text>
      </View>
      {orderedCategories(s).map((k) => {
        const label = CATEGORY_LABELS[k]?.label ?? k;
        return (
          <View key={k} style={{ flexDirection: "row", alignItems: "center", minHeight: 60, paddingHorizontal: space.lg, borderTopWidth: 1, borderTopColor: colors.line }}>
            <View style={{ flex: 1, paddingRight: space.sm }}>
              <Text style={{ color: colors.fg, fontSize: 16 }}>{label}</Text>
              {CATEGORY_LABELS[k] ? <Text style={font.tiny}>{CATEGORY_LABELS[k].hint}</Text> : null}
            </View>
            <View style={{ width: 64, alignItems: "center" }}>
              <Switch value={s[k].inApp} onValueChange={(v) => save.mutate({ category: k, key: "inApp", value: v })} accessibilityLabel={`${label} in app`} testID={`inapp-${k}`}
                trackColor={{ true: colors.brand, false: colors.elevated }} />
            </View>
            <View style={{ width: 64, alignItems: "center" }}>
              <Switch value={s[k].push} onValueChange={(v) => save.mutate({ category: k, key: "push", value: v })} accessibilityLabel={`${label} push`} testID={`push-${k}`}
                trackColor={{ true: colors.brand, false: colors.elevated }} />
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}
