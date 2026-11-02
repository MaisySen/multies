/**
 * M3 (1.10.11): one form's responses on the phone, newest first, each with its first answers. Share sends the form's
 * public link through the phone's share sheet.
 */
import { RefreshControl, ScrollView, Share, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, EmptyState, Loading } from "@/components/ui";
import { ListHeader, Problem, ScreenHeader } from "@/components/m3-ui";
import { useFormResponses } from "@/lib/m3-queries";
import { responsePreview } from "@/lib/m3";
import { timeAgo } from "@/lib/format";
import { colors, font, radius, space } from "@/theme";

export default function FormResponsesScreen() {
  const { id, name, url } = useLocalSearchParams<{ id: string; name?: string; url?: string }>();
  const insets = useSafeAreaInsets();
  const q = useFormResponses(id);
  const share = typeof url === "string" && /^https:\/\//.test(url)
    ? <Button label="Share form link" icon="link" variant="secondary" onPress={() => { Share.share({ message: url, url }).catch(() => {}); }} testID="form-share" />
    : null;
  const header = <ScreenHeader title={name || "Responses"} back="Forms" />;
  if (q.isPending) return <View style={{ flex: 1, backgroundColor: colors.bg }}>{header}<Loading label="Loading responses" rows={5} variant="task" /></View>;
  if (q.isError) return <View style={{ flex: 1, backgroundColor: colors.bg }} testID="form-error">{header}<Problem q={q} what="Responses" testID="form" /></View>;
  const d = q.data!;
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="form-screen">{header}
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: insets.bottom + space.xl, gap: space.md }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} tintColor={colors.muted} />}>
        <View style={{ paddingTop: space.md }}>{share}</View>
        {!d.responses.length ? <EmptyState icon="inbox" title="No responses yet" body="Responses show here as soon as someone sends the form." /> : (
          <>
            <ListHeader title="Responses" right={`${d.total}`} />
            {d.responses.map((r) => (
              <View key={r.id} testID={`response-${r.id}`} style={{ backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg, gap: space.sm }}>
                <Text style={font.tiny}>{timeAgo(r.createdAt)}</Text>
                {responsePreview(r, d.fields, 6).map((a) => (
                  <View key={a.label} style={{ gap: 2 }}>
                    <Text style={[font.tiny, { color: colors.muted }]} numberOfLines={1}>{a.label}</Text>
                    <Text style={font.body} selectable>{a.value}</Text>
                  </View>
                ))}
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}
