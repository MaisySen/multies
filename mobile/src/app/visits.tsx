/**
 * M1 (1.10.9): Visits, the web's visit planner on the phone. Pick contacts and companies with a saved address, put them
 * in order, and open the whole route in Apple Maps (iPhone) or Google Maps (Android), from where you are. The plan is
 * kept on this phone. Up to the web's stop limit; a maps link takes at most 10 points, so a long day opens in parts.
 */
import { Alert, Linking, Platform, RefreshControl, ScrollView, Text, View } from "react-native";
import { Stack } from "expo-router";
import { Banner, Button, EmptyState, Icon, Loading } from "@/components/ui";
import { GroupRow, InsetGroup } from "@/components/grouped";
import { Footnote, LoadError, NoAccess, SmallIconButton } from "@/components/m1-work";
import { useOffline } from "@/lib/offline";
import { noAccess, notFoundErr, useVisitPlan, useVisits } from "@/lib/contacts-queries";
import {
  mapsAppFor, MAPS_APP_NAME, MAX_VISIT_STOPS, moveInPlan, plannedStops, routeLegs, routeUrls, shortAddress, shortestOrder, togglePlan, validPoint,
} from "@/lib/contacts";
import { flagOn, useWebConfig } from "@/lib/web-config";
import { colors, space } from "@/theme";

export default function Visits() {
  const cfg = useWebConfig();
  const maps = flagOn(cfg.data, "maps");
  const q = useVisits(maps);
  const [plan, setPlan, ready] = useVisitPlan();
  const offline = useOffline();
  const app = mapsAppFor(Platform.OS);

  const header = <Stack.Screen options={{ title: "Visits" }} />;
  if (cfg.isPending) return <>{header}<Loading label="Loading visits" rows={4} /></>;
  if (!maps || notFoundErr(q.error)) return <>{header}<EmptyState icon="map-pin" title="Maps are off" body="Visit planning is not turned on for this workspace." art={null} /></>;
  if (noAccess(q.error)) return <>{header}<NoAccess what="Visits" /></>;
  if (q.isPending || !ready) return <>{header}<Loading label="Loading visits" rows={4} /></>;
  if (q.error || !q.data) return <>{header}<LoadError title="Couldn't load visits" error={q.error} onRetry={() => q.refetch()} /></>;

  const limit = q.data.limit || MAX_VISIT_STOPS;
  const all = q.data.candidates;
  const stops = plannedStops(plan, all);
  const legs = routeLegs(stops);
  const urls = routeUrls(stops, app);
  const located = stops.filter((s) => validPoint(s)).length;

  const toggle = (id: string) => {
    const next = togglePlan({ ids: stops.map((s) => s.id) }, id, limit);
    if (next === "full") { Alert.alert("That's the most stops for one day", `A day can have up to ${limit} stops. Take one off to add another.`); return; }
    setPlan(next);
  };
  const open = async (url: string) => {
    try { await Linking.openURL(url); } catch { Alert.alert(`Couldn't open ${MAPS_APP_NAME[app]}`, "Check that it is installed on this phone."); }
  };

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ paddingTop: space.md, paddingBottom: space.xxl, gap: space.md }}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} />} testID="visits">
      {header}
      {offline ? <View style={{ marginHorizontal: space.lg }}><Banner text="You're offline. Showing your saved plan." /></View> : null}

      {all.length === 0 ? (
        <EmptyState icon="map-pin" title="No saved addresses yet" body="Add an address to a contact or company on the web, then plan your visits here." art={null} />
      ) : (
        <>
          <InsetGroup header={stops.length ? `Today's stops, ${stops.length} of ${limit}` : "Today's stops"} testID="visits-plan">
            {stops.length ? stops.map((s, i) => (
              <View key={s.id} style={{ flexDirection: "row", alignItems: "center", paddingLeft: space.lg }} testID={`visit-stop-${s.id}`}
                accessible={false}>
                <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: colors.brandFill, alignItems: "center", justifyContent: "center" }}
                  accessible accessibilityLabel={`Stop ${i + 1}`}>
                  <Text style={{ color: colors.brandFg, fontSize: 13, fontWeight: "700" }}>{i + 1}</Text>
                </View>
                <View style={{ flex: 1, paddingVertical: 10, paddingHorizontal: space.md }}>
                  <Text style={{ color: colors.fg, fontSize: 16 }} numberOfLines={1}>{s.name}</Text>
                  <Text style={{ color: colors.subtle, fontSize: 13 }} numberOfLines={2}>{shortAddress(s.address)}</Text>
                </View>
                <SmallIconButton icon="chevron-up" label={`Move ${s.name} earlier`} disabled={i === 0} onPress={() => setPlan(moveInPlan({ ids: stops.map((x) => x.id) }, s.id, -1))} testID={`visit-up-${s.id}`} />
                <SmallIconButton icon="chevron-down" label={`Move ${s.name} later`} disabled={i === stops.length - 1} onPress={() => setPlan(moveInPlan({ ids: stops.map((x) => x.id) }, s.id, 1))} testID={`visit-down-${s.id}`} />
                <SmallIconButton icon="x" label={`Take ${s.name} off the plan`} color={colors.subtle} onPress={() => toggle(s.id)} testID={`visit-remove-${s.id}`} />
              </View>
            )) : <GroupRow icon="map-pin" label="No stops yet" sub="Pick places below to plan your day." testID="visits-none" />}
          </InsetGroup>

          {stops.length ? (
            <View style={{ marginHorizontal: space.lg, gap: space.sm }}>
              {urls.map((u, i) => (
                <Button key={u} label={urls.length === 1 ? `Open route in ${MAPS_APP_NAME[app]}` : `Open part ${i + 1} of ${urls.length} in ${MAPS_APP_NAME[app]}`}
                  icon="compass" onPress={() => open(u)} testID={`visits-open-${i}`}
                  accessibilityHint={legs[i] ? `Directions through ${legs[i].stops.length} stops, by car` : undefined} />
              ))}
              {located >= 3 ? <Button label="Shortest order" icon="refresh-cw" variant="secondary" onPress={() => setPlan({ ids: shortestOrder(stops).map((s) => s.id) })} testID="visits-shortest" /> : null}
              <Button label="Clear the plan" variant="ghost" onPress={() => setPlan({ ids: [] })} testID="visits-clear" />
            </View>
          ) : null}
          {urls.length > 1 ? <Footnote>A maps link takes up to 10 points, so this day opens in {urls.length} parts. Each part starts where the last one ended.</Footnote> : null}

          <InsetGroup header="Places with an address" footer={`Addresses are saved on the web, on each contact or company. Up to ${limit} stops a day; your plan is kept on this phone.`} testID="visits-candidates">
            {all.map((c) => {
              const on = stops.some((s) => s.id === c.id);
              return (
                <GroupRow key={c.id} label={c.name} sub={shortAddress(c.address)} chevron={false} onPress={() => toggle(c.id)} testID={`visit-pick-${c.id}`}
                  hint={on ? "Takes it off the plan" : "Adds it to the plan"}
                  right={<View accessibilityElementsHidden importantForAccessibility="no"><Icon name={on ? "check-circle" : "circle"} size={22} color={on ? colors.brand : colors.subtle} filled={on} /></View>} />
              );
            })}
          </InsetGroup>
        </>
      )}
    </ScrollView>
  );
}
