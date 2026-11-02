/**
 * M4: Links on the phone (was a web page). Every short link with its clicks, tap to share, long press to open
 * where it goes. Pull to refresh. Making and editing links stays on the web for now.
 */
import { Pressable, RefreshControl, ScrollView, Share, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EmptyState, Icon, Loading } from "@/components/ui";
import { Problem, ScreenHeader } from "@/components/m3-ui";
import { GlassPill, Hero, m4s as st, TintIcon } from "@/components/m4-ui";
import { haptic, tick } from "@/lib/haptics";
import { openWeb } from "@/lib/web-open";
import { colors, font, space } from "@/theme";
import { useLinks } from "@/lib/m4-queries";
import { shortLabel, type ShortLink } from "@/lib/m4";

export default function Links() {
  const insets = useSafeAreaInsets();
  const q = useLinks();
  const header = <ScreenHeader title="Links" />;
  if (q.isError) return <View style={st.screen} testID="links-error">{header}<Problem q={q} what="Links" testID="links" /></View>;
  const links = q.data?.links ?? [];
  const total = links.reduce((a, l) => a + l.clicks, 0);
  return (
    <View style={st.screen} testID="links-screen">
      {header}
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: insets.bottom + space.xxl }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { tick(); q.refetch(); }} tintColor={colors.brand} />}>
        {q.isPending ? <Loading label="Loading links" rows={5} variant="task" /> : !links.length ? (
          <EmptyState icon="link" title="No links yet" body="Short links you make on the web show here with their clicks."
            action={<Pressable onPress={() => openWeb("/app/tools/links")} accessibilityRole="button" testID="links-create"><Text style={{ color: colors.brand, fontWeight: "600", fontSize: 16 }}>Make a link</Text></Pressable>} />
        ) : (
          <>
            <Hero testID="links-hero" title={`${total.toLocaleString("en-AU")} clicks`} subtitle={`Across ${links.length} ${links.length === 1 ? "link" : "links"}. Tap one to share it.`}>
              <GlassPill icon="plus" label="New link" onPress={() => openWeb("/app/tools/links")} testID="links-new" />
            </Hero>
            <View style={st.card}>{links.map((l, i) => <LinkRow key={l.id} l={l} last={i === links.length - 1} />)}</View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function LinkRow({ l, last }: { l: ShortLink; last: boolean }) {
  const share = async () => {
    tick();
    const r = await Share.share({ message: l.shortUrl, url: l.shortUrl }).catch(() => null);
    if (r && r.action === Share.sharedAction) haptic("success");
  };
  return (
    <Pressable onPress={share} onLongPress={() => { haptic("thud"); openWeb(l.url); }} testID={`link-${l.id}`} accessibilityRole="button"
      accessibilityLabel={`${l.title ?? shortLabel(l.shortUrl)}, ${l.clicks} clicks`} accessibilityHint="Shares the link. Long press opens where it goes."
      style={({ pressed }) => [st.row, !last && st.sep, pressed && { backgroundColor: colors.hover }, !l.enabled && { opacity: 0.55 }]}>
      <TintIcon icon="link" color={colors.brand} size={40} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={font.headline} numberOfLines={1}>{l.title ?? shortLabel(l.url)}</Text>
        <Text style={{ color: colors.brand, fontSize: 13 }} numberOfLines={1}>{shortLabel(l.shortUrl)}</Text>
      </View>
      <View style={{ alignItems: "flex-end" }}>
        <Text style={{ fontSize: 17, fontWeight: "600", color: colors.fg, fontVariant: ["tabular-nums"] }}>{l.clicks.toLocaleString("en-AU")}</Text>
        <Text style={[font.tiny]}>clicks</Text>
      </View>
      <Icon name="send" size={16} color={colors.subtle} />
    </Pressable>
  );
}

