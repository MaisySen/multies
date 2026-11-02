/**
 * M1 (1.10.9): Contacts on the phone, the same people as the web's Contacts page. Members only (the server decides).
 * When maps are on, Visits plans the day's stops and opens the route in the phone's maps app.
 */
import { useEffect, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { router, Stack } from "expo-router";
import { Avatar, Banner, Button, EmptyState, Loading } from "@/components/ui";
import { GroupRow, InsetGroup } from "@/components/grouped";
import { LoadError, NoAccess, SearchBox } from "@/components/m1-work";
import { useOffline } from "@/lib/offline";
import { useContacts, noAccess } from "@/lib/contacts-queries";
import { contactName, contactSub, contactSearchTerm } from "@/lib/contacts";
import { flagOn, useWebConfig } from "@/lib/web-config";
import { colors, space } from "@/theme";

export default function Contacts() {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => { const t = setTimeout(() => setQ(contactSearchTerm(text)), 250); return () => clearTimeout(t); }, [text]);
  const list = useContacts(q);
  const cfg = useWebConfig();
  const maps = flagOn(cfg.data, "maps");
  const offline = useOffline();

  const header = <Stack.Screen options={{ title: "Contacts" }} />;
  if (noAccess(list.error)) return <>{header}<NoAccess what="Contacts" /></>;
  const rows = list.data?.contacts ?? [];

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ paddingTop: space.md, paddingBottom: space.xxl, gap: space.md }}
      keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={list.isRefetching} onRefresh={() => { list.refetch(); }} />} testID="contacts">
      {header}
      {offline ? <View style={{ marginHorizontal: space.lg }}><Banner text="You're offline. Contacts load when you're back online." /></View> : null}
      <SearchBox value={text} onChange={setText} label="Search contacts" placeholder="Search by name or email" testID="contacts-search" />
      {maps ? (
        <View style={{ marginHorizontal: space.lg }}>
          <Button label="Plan visits" icon="map-pin" variant="secondary" onPress={() => router.push("/visits")} testID="contacts-visits"
            accessibilityHint="Pick stops with an address and open the route in your maps app" />
        </View>
      ) : null}
      {list.isPending ? <Loading label="Loading contacts" rows={6} /> : list.error ? (
        <LoadError title="Couldn't load contacts" error={list.error} onRetry={() => list.refetch()} />
      ) : rows.length === 0 ? (
        q ? <EmptyState icon="search" title="No contacts match" body="Try part of a name or an email address." art={null} />
          : <EmptyState icon="users" title="No contacts yet" body="People you email are added here on their own. You can also add contacts on the web." art={null} />
      ) : (
        <InsetGroup footer={list.data && list.data.total > rows.length ? `Showing ${rows.length} of ${list.data.total}. Search to find someone else.` : undefined} testID="contacts-list">
          {rows.map((c) => (
            <GroupRow key={c.id} label={contactName(c)} sub={contactSub(c)} right={<View style={{ marginRight: space.xs }}><Avatar name={contactName(c)} size={32} /></View>}
              onPress={() => router.push({ pathname: "/contact/[id]", params: { id: c.id } })} testID={`contact-${c.id}`} hint="Opens the contact" />
          ))}
        </InsetGroup>
      )}
      {!list.isPending && !list.error && text.trim().length > q.length && q ? (
        <Text style={{ color: colors.subtle, fontSize: 13, marginHorizontal: space.xl }} testID="contacts-trimmed">Searching for the first part: “{q}”.</Text>
      ) : null}
    </ScrollView>
  );
}
