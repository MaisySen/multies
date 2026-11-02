/**
 * M2 (1.10.10): Deals, the web's Contacts > Deals pipeline on the phone: stages in order with their totals, search, and
 * each deal's detail. Members see what the server lets them see; an error shows Retry; no deals shows how to start.
 */
import { useState } from "react";
import { RefreshControl, SectionList, Text, TextInput, View } from "react-native";
import { router, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GroupRow } from "@/components/grouped";
import { Button, EmptyState, Icon, Loading } from "@/components/ui";
import { useDeals } from "@/lib/deals-queries";
import { byStage, dealLine, money, pipeline } from "@/lib/deals";
import { noAccess } from "@/lib/contacts-queries";
import { useSession } from "@/lib/session";
import { openWebPage } from "@/lib/web-open";
import { colors, font, radius, space, TOUCH } from "@/theme";

export default function Deals() {
  const insets = useSafeAreaInsets();
  const { transport } = useSession();
  const q = useDeals();
  const [filter, setFilter] = useState("");
  const header = <Stack.Screen options={{ title: "Deals" }} />;
  if (q.isPending) return <View style={{ flex: 1, backgroundColor: colors.bg }}>{header}<Loading label="Loading deals" rows={6} variant="task" /></View>;
  if (q.isError) {
    const denied = noAccess(q.error);
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }} testID="deals-error">{header}
        <EmptyState icon={denied ? "lock" : "alert-circle"} title={denied ? "Deals aren't open to you" : "Couldn't load deals"}
          body={denied ? "Ask an admin of this workspace for access." : "Check your connection and try again."}
          action={denied ? undefined : <Button label="Retry" onPress={() => q.refetch()} testID="deals-retry" />} />
      </View>
    );
  }
  const total = q.data?.deals.length ?? 0;
  if (!total) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }} testID="deals-empty">{header}
        <EmptyState icon="dollar-sign" title="No deals yet" body="Add your first deal on the web. It shows here as soon as it's saved."
          action={<Button label="Open Deals on the web" icon="external-link" variant="secondary" onPress={() => openWebPage(transport, "/app/deals")} testID="deals-open-web" />} />
      </View>
    );
  }
  const p = pipeline(q.data);
  const sections = byStage(q.data, filter).filter((s) => s.items.length || !filter).map((s) => ({ ...s, data: s.items }));
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="deals-screen">{header}
      <SectionList
        sections={sections}
        keyExtractor={(d) => d.id}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: insets.bottom + space.xl }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} tintColor={colors.muted} />}
        ListHeaderComponent={
          <View style={{ gap: space.md, paddingTop: space.md }}>
            <View accessible accessibilityLabel={`Open pipeline: ${p.count} deals worth ${money(p.value)}, forecast ${money(p.forecast)}`}
              style={{ flexDirection: "row", backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.md, gap: space.md }} testID="deals-pipeline">
              <View style={{ flex: 1 }}><Text style={font.tiny}>Open pipeline</Text><Text style={[font.headline, { color: colors.fg }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{money(p.value)}</Text></View>
              <View style={{ flex: 1 }}><Text style={font.tiny}>Forecast</Text><Text style={[font.headline, { color: colors.fg }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{money(p.forecast)}</Text></View>
              <View style={{ flexShrink: 0, minWidth: 44 }}><Text style={font.tiny}>Open</Text><Text style={[font.headline, { color: colors.fg }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{p.count}</Text></View>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: TOUCH, paddingHorizontal: space.md, borderRadius: radius.md, backgroundColor: colors.elevated }}>
              <Icon name="search" size={18} color={colors.subtle} />
              <TextInput value={filter} onChangeText={setFilter} placeholder="Search deals" placeholderTextColor={colors.subtle} accessibilityLabel="Search deals" testID="deals-search"
                autoCorrect={false} autoCapitalize="none" returnKeyType="search" selectionColor={colors.brand} style={{ flex: 1, minHeight: TOUCH, color: colors.fg, fontSize: 17 }} />
            </View>
          </View>
        }
        ListEmptyComponent={<EmptyState icon="search" title="No matching deals" body="Try another name or company." />}
        renderSectionHeader={({ section }) => (
          <View style={{ flexDirection: "row", justifyContent: "space-between", paddingTop: space.lg, paddingBottom: space.xs, paddingHorizontal: space.xs }} accessibilityRole="header"
            accessible accessibilityLabel={`${section.name}, ${section.data.length} ${section.data.length === 1 ? "deal" : "deals"}, ${money(section.total)}`}>
            <Text style={[font.tiny, { fontWeight: "600", color: colors.muted }]}>{section.name.toUpperCase()} · {section.data.length}</Text>
            <Text style={[font.tiny, { color: colors.muted }]}>{money(section.total)}</Text>
          </View>
        )}
        renderItem={({ item, index, section }) => (
          <View style={{ backgroundColor: colors.surface, borderTopLeftRadius: index === 0 ? radius.lg : 0, borderTopRightRadius: index === 0 ? radius.lg : 0,
            borderBottomLeftRadius: index === section.data.length - 1 ? radius.lg : 0, borderBottomRightRadius: index === section.data.length - 1 ? radius.lg : 0, overflow: "hidden" }}>
            <GroupRow testID={`deal-${item.id}`} label={item.title} sub={dealLine(item) || null} value={money(item.value, item.currency)}
              onPress={() => router.push({ pathname: "/deal/[id]", params: { id: item.id } })} />
          </View>
        )}
        renderSectionFooter={({ section }) => (!section.data.length ? (
          <View style={{ backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.md }}><Text style={font.tiny}>No deals in this stage</Text></View>
        ) : null)}
      />
    </View>
  );
}
