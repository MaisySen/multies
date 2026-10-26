import { Pressable, ScrollView, Text, View } from "react-native";
import { Avatar, EmptyState, Loading, Button } from "@/components/ui";
import { SwipeRow } from "@/components/swipe-row";
import { g } from "@/components/grouped";
import { success } from "@/lib/haptics";
import { useBlocks, useUnblockPerson } from "@/lib/queries";
import { colors, radius, space, TOUCH } from "@/theme";

/**
 * R35: Settings, Privacy and safety, Blocked people. Unblock with the button or by swiping the row.
 * Blocking happens in chat (press and hold a message, or the menu in a DM).
 */
export default function BlockedPeople() {
  const q = useBlocks();
  const unblock = useUnblockPerson();
  if (q.isPending) return <Loading rows={3} label="Loading blocked people" />;
  if (q.error) return <EmptyState icon="alert-circle" title="Couldn't load blocked people" body={q.error.message} action={<Button label="Try again" variant="secondary" onPress={() => q.refetch()} />} />;
  const list = q.data.blocks;
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: colors.bg }} contentContainerStyle={{ padding: space.lg, gap: 7, paddingBottom: space.xxl }} testID="blocked-people">
      {list.length === 0 ? (
        <EmptyState icon="user-check" title="No one is blocked" body="To block someone, press and hold one of their messages in chat, or open the menu in your direct message with them." />
      ) : (
        <>
          <Text style={g.header} accessibilityRole="header">{list.length === 1 ? "1 person" : `${list.length} people`}</Text>
          <View style={[g.group, { marginHorizontal: 0 }]}>
            {list.map((b, i) => (
              <SwipeRow key={b.userId} testID={`blocked-${b.userId}`}
                right={{ label: "Unblock", icon: "user-check", color: colors.brand, onAction: () => { success(); unblock.mutate(b.userId); } }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingLeft: space.md, backgroundColor: colors.surface }}>
                  <Avatar name={b.name} size={36} />
                  <View style={{ flex: 1, flexDirection: "row", alignItems: "center", minHeight: TOUCH + 12, paddingRight: space.md, borderBottomWidth: i === list.length - 1 ? 0 : 0.5, borderBottomColor: colors.line }}>
                    <Text style={{ flex: 1, color: colors.fg, fontSize: 16 }} numberOfLines={1}>{b.name}</Text>
                    <Pressable onPress={() => { success(); unblock.mutate(b.userId); }} accessibilityRole="button" accessibilityLabel={`Unblock ${b.name}`} testID={`unblock-${b.userId}`} hitSlop={8}
                      style={({ pressed }) => ({ paddingHorizontal: space.md, minHeight: 32, borderRadius: radius.pill, justifyContent: "center", backgroundColor: pressed ? colors.hover : colors.brandSoft })}>
                      <Text style={{ color: colors.brand, fontSize: 14, fontWeight: "600" }}>Unblock</Text>
                    </Pressable>
                  </View>
                </View>
              </SwipeRow>
            ))}
          </View>
          <Text style={[g.footer, { marginHorizontal: space.lg }]}>{"You don't see messages from these people, and they can't message you. They aren't told. Swipe left on a row to unblock."}</Text>
        </>
      )}
    </ScrollView>
  );
}
