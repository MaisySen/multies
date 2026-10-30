import { ScrollView, Switch, Text, View } from "react-native";
import { Banner, Button, EmptyState, Loading, TILE, type IconName, type TileColor } from "@/components/ui";
import { GroupRow, InsetGroup } from "@/components/grouped";
import { tick } from "@/lib/haptics";
import { useNotificationSettings, useSaveNotificationSetting } from "@/lib/queries";
import { CATEGORY_LABELS, orderedCategories } from "@/lib/notifications";
import { colors, space } from "@/theme";

/** Per category: show it in the inbox, and send a push to this phone. */
export default function NotificationSettings() {
  const q = useNotificationSettings();
  const save = useSaveNotificationSetting();
  if (q.isPending) return <Loading />;
  if (q.error) return <EmptyState icon="alert-circle" title="Couldn't load your settings" body={q.error.message} action={<Button label="Try again" variant="secondary" onPress={() => q.refetch()} />} />;
  const s = q.data;
  const cats = orderedCategories(s);
  const flip = (category: (typeof cats)[number], key: "inApp" | "push", value: boolean) => { tick(); save.mutate({ category, key, value }); };
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: space.xxl * 2 }} testID="notification-settings">
      {save.error ? <Banner tone="bad" icon="alert-circle" text={`Couldn't save: ${save.error.message}`} /> : null}
      {/* R36: inset grouped like iOS Settings: one row per category, two labelled switches on the right. */}
      <InsetGroup header="Categories" footer="In app shows it in your notifications inbox. Push also sends it to this phone, which needs notifications allowed in the phone's Settings.">
        {cats.map((k, i) => {
          const label = CATEGORY_LABELS[k]?.label ?? k;
          return (
            <GroupRow key={k} icon={CAT_ICONS[i % CAT_ICONS.length][0]} tile={CAT_ICONS[i % CAT_ICONS.length][1]} label={label} sub={CATEGORY_LABELS[k]?.hint ?? null}
              right={(
                <View style={{ flexDirection: "row", gap: space.sm }}>
                  <View style={{ alignItems: "center", gap: 2 }}>
                    <Switch value={s[k].inApp} onValueChange={(v) => flip(k, "inApp", v)} accessibilityLabel={`${label} in app`} testID={`inapp-${k}`}
                      trackColor={{ true: TILE.green, false: colors.elevated }} />
                    <Text style={{ color: colors.subtle, fontSize: 11 }}>In app</Text>
                  </View>
                  <View style={{ alignItems: "center", gap: 2 }}>
                    <Switch value={s[k].push} onValueChange={(v) => flip(k, "push", v)} accessibilityLabel={`${label} push`} testID={`push-${k}`}
                      trackColor={{ true: TILE.green, false: colors.elevated }} />
                    <Text style={{ color: colors.subtle, fontSize: 11 }}>Push</Text>
                  </View>
                </View>
              )} />
          );
        })}
      </InsetGroup>
    </ScrollView>
  );
}

const CAT_ICONS: [IconName, TileColor][] = [["mention", "blue"], ["check-square", "orange"], ["chat", "green"], ["approvals", "purple"], ["calendar", "red"], ["bell", "teal"], ["bot", "indigo"], ["mail", "pink"]];
