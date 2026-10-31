import { Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { router, Stack } from "expo-router";
import { Banner, Button, EmptyState, Icon, Loading } from "@/components/ui";
import { GroupRow, InsetGroup } from "@/components/grouped";
import { useInboxTabs, useMailMutations, useMailRules, useTabSettings } from "@/lib/mail-queries";
import { ruleSummary, sendsMail, TAB_STYLES, type TabStyle } from "@/lib/mail-rules";
import { useOffline } from "@/lib/offline";
import { success, tick, warning } from "@/lib/haptics";
import { showQuickToast } from "@/lib/quick-actions";
import { colors, space } from "@/theme";

/**
 * 1.10.7: Settings, Mail. The Inbox tab style (the same setting as the web) and the mail rules: every rule in its
 * running order with an on or off switch, New rule, and a page per rule. Rules that forward mail or send a saved reply
 * are made and changed on the web; here they can be turned on or off and deleted.
 */
export default function MailSettings() {
  const offline = useOffline();
  const settings = useTabSettings();
  const tabs = useInboxTabs();
  const rules = useMailRules();
  const mm = useMailMutations();
  const style: TabStyle | undefined = mm.setStyle.isPending ? mm.setStyle.variables : settings.data?.style;
  const tabName = (id: string) => tabs.data?.tabs.find((t) => t.id === id)?.name;
  const pick = (s: TabStyle) => {
    if (s === style) return;
    mm.setStyle.mutate(s, {
      onSuccess: () => { success(); settings.refetch(); },
      onError: () => { warning(); showQuickToast("Couldn't change the tabs", "bad"); },
    });
  };
  const toggle = (id: string, enabled: boolean) => mm.updateRule.mutate({ id, patch: { enabled } }, {
    onError: () => { warning(); showQuickToast("Couldn't change the rule", "bad"); },
  });

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: 48 }}
      refreshControl={<RefreshControl refreshing={rules.isRefetching} onRefresh={() => { rules.refetch(); settings.refetch(); }} tintColor={colors.brand} colors={[colors.brand]} />}>
      <Stack.Screen options={{ title: "Mail" }} />
      {offline ? <Banner text="You're offline. Rules and tabs change when you're back online." /> : null}

      <InsetGroup header="Inbox tabs" footer="The same setting as on the web. Switch tabs with a tap at the top of Inbox." testID="tab-styles">
        {settings.isPending ? <Loading rows={2} label="Loading tabs" /> : settings.error && !settings.data ? (
          <GroupRow label="Couldn't load your tabs" sub="Tap to try again" icon="alert-circle" onPress={() => settings.refetch()} />
        ) : TAB_STYLES.map((t) => (
          <GroupRow key={t.id} label={t.label} sub={t.hint} onPress={offline ? undefined : () => pick(t.id)} chevron={false} testID={`tab-style-${t.id}`}
            hint={style === t.id ? "Chosen" : "Choose this style"}
            right={style === t.id ? <Icon name="check" size={20} color={colors.brand} /> : undefined} />
        ))}
      </InsetGroup>

      <InsetGroup header="Mail rules" footer="Rules run on new mail, top to bottom. Rules that forward mail or send a reply are made on the web." testID="rules">
        {rules.isPending ? <Loading rows={3} label="Loading rules" /> : rules.error && !rules.data ? (
          <EmptyState icon="alert-circle" title="Couldn't load your rules" body="Check your connection and try again." action={<Button label="Try again" variant="secondary" onPress={() => rules.refetch()} />} />
        ) : !rules.data?.length ? (
          <EmptyState icon="filter" title="No rules yet" body="Sort, label or archive mail as it arrives." />
        ) : rules.data.map((r, i) => (
          <View key={r.id} style={{ flexDirection: "row", alignItems: "center", paddingRight: space.lg, borderTopWidth: i ? StyleSheet.hairlineWidth : 0, borderTopColor: colors.line }}>
            <Pressable onPress={() => { tick(); router.push({ pathname: "/mail-rule/[id]", params: { id: r.id } }); }} accessibilityRole="button" accessibilityHint="Opens the rule"
              accessibilityLabel={`${r.name}. ${ruleSummary(r, tabName)}${sendsMail(r) ? ". Change it on the web" : ""}`} testID={`rule-${r.id}`}
              style={({ pressed }) => ({ flex: 1, paddingVertical: 11, paddingLeft: space.lg, paddingRight: space.md, gap: 2, opacity: pressed ? 0.6 : 1 })}>
              <Text style={{ color: colors.fg, fontSize: 16 }} numberOfLines={1}>{r.name}</Text>
              <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 18 }} numberOfLines={3}>{ruleSummary(r, tabName)}{sendsMail(r) ? ". Change it on the web" : ""}</Text>
            </Pressable>
            <Switch value={r.enabled} disabled={offline} onValueChange={(v) => { tick(); toggle(r.id, v); }} accessibilityLabel={`${r.name}, ${r.enabled ? "on" : "off"}`}
              testID={`rule-${r.id}-switch`} trackColor={{ true: colors.ok, false: colors.elevated }} />
          </View>
        ))}
      </InsetGroup>
      <View style={{ paddingHorizontal: space.lg, marginTop: space.md }}>
        <Button label="New rule" icon="plus" onPress={() => router.push({ pathname: "/mail-rule/[id]", params: { id: "new" } })} disabled={offline} testID="new-rule" />
        {offline ? <Text style={{ color: colors.subtle, fontSize: 13, marginTop: space.sm, textAlign: "center" }}>{"You're offline"}</Text> : null}
      </View>
    </ScrollView>
  );
}
