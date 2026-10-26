import { useMemo, useState } from "react";
import { FlatList, RefreshControl, ScrollView, View } from "react-native";
import { NotificationBell } from "@/components/notification-bell";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, Stack } from "expo-router";
import { Banner, Chip, EmptyState, IconButton, Loading, Button, LargeTitle } from "@/components/ui";
import { MessageRow } from "@/components/message-row";
import { SwipeHint, SwipeRow } from "@/components/swipe-row";
import { UndoToast } from "@/components/undo-toast";
import { useMailRowActions } from "@/components/mail-actions";
import { useUndoQueue } from "@/lib/undo-queue";
import { usePrefs } from "@/lib/prefs";
import { openCommandSheet } from "@/lib/command-sheet-store";
import { useAgents, useMessages, useOverview } from "@/lib/queries";
import { useOffline } from "@/lib/offline";
import { useSession } from "@/lib/session";
import type { ListFolder } from "@/api/types";
import { colors, space } from "@/theme";

const FOLDERS: { id: ListFolder; label: string }[] = [
  { id: "inbox", label: "Inbox" }, { id: "starred", label: "Starred" }, { id: "sent", label: "Sent" }, { id: "archive", label: "Archive" },
];

export default function Inbox() {
  const [folder, setFolder] = useState<ListFolder>("inbox");
  const [mailboxId, setMailboxId] = useState<string | undefined>();
  const list = useMessages(folder, mailboxId);
  const overview = useOverview();
  const agents = useAgents();
  const offline = useOffline();
  const { mode } = useSession();
  // R31: swipe right to archive, left to snooze, long-press for every action. Swiped rows hide at once with Undo.
  const undo = useUndoQueue();
  const actions = useMailRowActions(undo.push);
  const prefs = usePrefs(); // R33: the swipe actions chosen in Settings
  const swipeable = folder === "inbox" || folder === "starred";
  const rows = useMemo(() => (list.data?.pages.flatMap((p) => p.messages) ?? []).filter((m) => !undo.hidden.has(m.id)), [list.data, undo.hidden]);
  const people = overview.data?.filter((m) => m.kind !== "agent") ?? [];
  const unread = (id?: string) => overview.data?.filter((m) => !id || m.id === id).reduce((n, m) => n + (m.folders.inbox?.unread ?? 0), 0) ?? 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ headerShown: false }} />
      <Header onSearch={() => router.push("/search")} />
      {offline ? <Banner text="You're offline. Showing mail saved on this phone." /> : null}
      {mode === "sample" ? <Banner tone="brand" icon="compass" text="Sample workspace. Nothing here is real mail." /> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm }} style={{ flexGrow: 0 }}>
        {FOLDERS.map((f) => <Chip key={f.id} label={f.label} selected={folder === f.id} count={f.id === "inbox" ? unread(mailboxId) : undefined} onPress={() => setFolder(f.id)} />)}
        {people.length > 1 ? <View style={{ width: 1, backgroundColor: colors.line, marginHorizontal: 4 }} /> : null}
        {people.length > 1 ? <Chip label="All mailboxes" selected={!mailboxId} onPress={() => setMailboxId(undefined)} /> : null}
        {people.length > 1 ? people.map((m) => <Chip key={m.id} label={m.address.split("@")[0]} selected={mailboxId === m.id} onPress={() => setMailboxId(m.id)} />) : null}
      </ScrollView>
      {swipeable && rows.length ? <SwipeHint /> : null}
      {list.isPending ? <Loading label="Loading mail" /> : list.error && !rows.length ? (
        <EmptyState icon="alert-circle" title="Couldn't load your mail" body={list.error.message} action={<Button label="Try again" variant="secondary" onPress={() => list.refetch()} />} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(m) => m.id}
          renderItem={({ item }) => {
            const row = <MessageRow m={item} agents={agents.data} showRecipient={folder === "sent"} onLongPress={() => actions.openMenu(item)}
              onPress={() => router.push({ pathname: "/thread/[id]", params: { id: item.id } })} />;
            return swipeable ? (
              <SwipeRow testID={`swipe-${item.id}`}
                right={actions.swipeFor(item, prefs.mailSwipes.rightShort)} rightLong={actions.swipeFor(item, prefs.mailSwipes.rightLong)}
                left={actions.swipeFor(item, prefs.mailSwipes.leftShort)} leftLong={actions.swipeFor(item, prefs.mailSwipes.leftLong)}>
                {row}
              </SwipeRow>
            ) : row;
          }}
          refreshControl={<RefreshControl refreshing={list.isRefetching && !list.isFetchingNextPage} onRefresh={() => { list.refetch(); }} tintColor={colors.brand} colors={[colors.brand]} />}
          onEndReached={() => list.hasNextPage && !list.isFetchingNextPage && list.fetchNextPage()}
          onEndReachedThreshold={0.4}
          ListFooterComponent={list.isFetchingNextPage ? <Loading label="Loading more" /> : undefined}
          ListEmptyComponent={<EmptyState icon="inbox" title={folder === "inbox" ? "You're all caught up" : "Nothing here"} body={folder === "inbox" ? "New mail shows up here." : undefined} />}
          contentContainerStyle={{ paddingBottom: 96 }}
        />
      )}
      {actions.sheets}
      <UndoToast pending={undo.newest} onUndo={undo.undo} bottom={space.lg + 64} />
      <View style={{ position: "absolute", right: space.lg, bottom: space.lg }}>
        <Button label="Compose" icon="edit-3" onPress={() => router.push("/compose")} testID="compose" style={{ borderRadius: 28, paddingHorizontal: 22, shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 4 }} />
      </View>
    </View>
  );
}

function Header({ onSearch }: { onSearch: () => void }) {
  const { me } = useSession();
  const insets = useSafeAreaInsets();
  return (
    <LargeTitle title="Mail" subtitle={me?.organization?.name} top={insets.top} right={(
      <>
        <NotificationBell />
        <IconButton icon="command" label="Commands" onPress={openCommandSheet} testID="open-commands" />
        <IconButton icon="search" label="Search mail" onPress={onSearch} testID="open-search" />
      </>
    )} />
  );
}
