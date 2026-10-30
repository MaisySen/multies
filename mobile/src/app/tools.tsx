import { RefreshControl, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { Banner, Button, EmptyState, Loading } from "@/components/ui";
import { InsetGroup, GroupRow } from "@/components/grouped";
import { useTools } from "@/lib/queries";
import { useOffline } from "@/lib/offline";
import { GROUP_TILE, groupTools, toolIcon, usageLine } from "@/lib/tools";
import { colors, font, space } from "@/theme";

/**
 * Tools: the document tools from Multies on the web (compress, merge, convert and the rest), on the phone.
 * The list comes from the server, so it always matches the web. Tapping a tool opens its sheet.
 */
export default function Tools() {
  const q = useTools();
  const offline = useOffline();
  if (q.isPending) return <Loading rows={8} />;
  if (q.error) {
    const off = (q.error as { status?: number }).status === 404;
    return off
      ? <EmptyState icon="wrench" title="Tools are off" body="Tools are switched off for this workspace. An admin can turn them on in Settings, General on multies.si." />
      : <EmptyState icon="alert-circle" title="Couldn't load Tools" body={q.error.message} action={<Button label="Try again" variant="secondary" onPress={() => q.refetch()} />} />;
  }
  const usage = usageLine(q.data);
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: space.xxl * 2 }} testID="tools"
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} />}>
      {offline ? <View style={{ padding: space.lg }}><Banner text="You're offline. Tools need a connection to run." /></View> : null}
      <Text style={[font.small, { marginHorizontal: space.lg, marginTop: space.md }]} testID="tools-usage">{usage.text}</Text>
      {groupTools(q.data.tools).map(({ group, tools }) => (
        <InsetGroup key={group} header={group} testID={`tools-group-${group}`}>
          {tools.map((t) => (
            <GroupRow key={t.op} label={t.label} sub={t.blurb} icon={toolIcon(t.op)} tile={GROUP_TILE[group] ?? "gray"} testID={`tool-${t.op}`}
              onPress={() => router.push({ pathname: "/tool/[op]", params: { op: t.op } })} />
          ))}
        </InsetGroup>
      ))}
      <Text style={[font.tiny, { marginHorizontal: space.lg, marginTop: space.lg }]}>
        Files run on our document engine and are deleted within an hour. You can also run a tool on a mail attachment: open the email and tap the attachment.
      </Text>
    </ScrollView>
  );
}
