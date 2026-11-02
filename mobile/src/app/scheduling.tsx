/**
 * M4: Scheduling on the phone (was a web page). Your booking link to share in one tap and the bookings coming up,
 * by day. Pull to refresh. Changing hours and the page itself stays on the web for now.
 */
import { Pressable, RefreshControl, ScrollView, Share, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EmptyState, Loading } from "@/components/ui";
import { Problem, ScreenHeader } from "@/components/m3-ui";
import { GlassPill, Hero, m4s as st, TintIcon } from "@/components/m4-ui";
import { haptic, tick } from "@/lib/haptics";
import { openWeb } from "@/lib/web-open";
import { colors, font, space } from "@/theme";
import { useBookingPage, useBookings } from "@/lib/m4-queries";
import { bookingDays, shortLabel, timeRange } from "@/lib/m4";

export default function Scheduling() {
  const insets = useSafeAreaInsets();
  const page = useBookingPage();
  const bookings = useBookings();
  const header = <ScreenHeader title="Scheduling" />;
  if (page.isError) return <View style={st.screen} testID="scheduling-error">{header}<Problem q={page} what="Scheduling" testID="scheduling" /></View>;
  const p = page.data;
  const days = bookingDays(bookings.data?.pages.flatMap((x) => x.bookings));
  const share = async () => {
    if (!p) return;
    tick();
    const r = await Share.share({ message: `Book a time with me: ${p.url}`, url: p.url }).catch(() => null);
    if (r && r.action === Share.sharedAction) haptic("success");
  };
  return (
    <View style={st.screen} testID="scheduling-screen">
      {header}
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: insets.bottom + space.xxl }}
        refreshControl={<RefreshControl refreshing={bookings.isRefetching} onRefresh={() => { tick(); page.refetch(); bookings.refetch(); }} tintColor={colors.brand} />}>
        {page.isPending ? <Loading label="Loading your booking page" rows={2} variant="task" /> : p ? (
          <Hero testID="scheduling-page" title={p.title} subtitle={`${shortLabel(p.url)}  ·  ${p.slotMin} minutes${p.enabled ? "" : "  ·  turned off"}`}>
            <GlassPill icon="send" label="Share link" onPress={share} testID="scheduling-share" />
            <GlassPill icon="edit" label="Edit hours" onPress={() => openWeb("/app/scheduling")} testID="scheduling-edit" />
          </Hero>
        ) : (
          <EmptyState icon="calendar" title="No booking page yet" body="Make one on the web and people can pick a time that suits you both."
            action={<Pressable onPress={() => openWeb("/app/scheduling")} accessibilityRole="button" testID="scheduling-create"><Text style={{ color: colors.brand, fontWeight: "600", fontSize: 16 }}>Make a booking page</Text></Pressable>} />
        )}
        {p ? (bookings.isPending ? <Loading label="Loading bookings" rows={3} variant="task" /> : !days.length ? (
          <EmptyState icon="calendar" title="No bookings coming up" body="When someone books a time it shows here." />
        ) : days.map((d) => (
          <View key={d.day} style={{ gap: space.sm }}>
            <Text style={{ ...font.headline, marginLeft: space.xs }} accessibilityRole="header">{d.day}</Text>
            <View style={st.card}>
              {d.items.map((b, i) => (
                <View key={b.id} style={[st.row, i < d.items.length - 1 && st.sep]} accessible accessibilityLabel={`${b.name}, ${timeRange(b)}${b.note ? `, ${b.note}` : ""}`} testID={`booking-${b.id}`}>
                  <TintIcon icon="calendar" color={colors.brand} size={40} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={font.headline} numberOfLines={1}>{b.name}</Text>
                    <Text style={[font.small, { fontSize: 13 }]} numberOfLines={1}>{b.note ?? b.email}</Text>
                  </View>
                  <Text style={{ color: colors.brand, fontWeight: "600", fontSize: 15 }}>{timeRange(b).split(" to ")[0]}</Text>
                </View>
              ))}
            </View>
          </View>
        ))) : null}
      </ScrollView>
    </View>
  );
}
