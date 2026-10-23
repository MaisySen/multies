import { useEffect, useState } from "react";
import { FlatList, View } from "react-native";
import { router } from "expo-router";
import { Banner, EmptyState, Field, Loading } from "@/components/ui";
import { MessageRow } from "@/components/message-row";
import { useAgents, useSearch } from "@/lib/queries";
import { searchCache, useOffline } from "@/lib/offline";
import { kv } from "@/lib/kv";
import type { MessageSummary } from "@/api/types";
import { colors, space } from "@/theme";

export default function Search() {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => { const t = setTimeout(() => setQ(text.trim()), 300); return () => clearTimeout(t); }, [text]);
  const res = useSearch(q);
  const agents = useAgents();
  const offline = useOffline();
  const [local, setLocal] = useState<MessageSummary[] | null>(null);

  // No connection: search what's already on the phone.
  useEffect(() => {
    if (q.length >= 2 && (offline || (res.error as { status?: number } | null)?.status === 0)) searchCache(kv(), q).then(setLocal);
    else setLocal(null);
  }, [q, offline, res.error]);

  const rows = local ?? res.data?.messages ?? [];
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ padding: space.lg }}>
        <Field label="Search" testID="search" value={text} onChangeText={setText} autoFocus placeholder="People, subjects, words in the message"
          returnKeyType="search" autoCapitalize="none" clearButtonMode="while-editing" />
      </View>
      {local ? <Banner text="Offline. Searching mail saved on this phone." /> : null}
      {q.length < 2 ? <EmptyState icon="search" title="Search your mail" body="Type at least two letters. Results come from every mailbox you can open." />
        : res.isPending && !local ? <Loading label="Searching" />
        : (
          <FlatList data={rows} keyExtractor={(m) => m.id}
            renderItem={({ item }) => <MessageRow m={item} agents={agents.data} onPress={() => router.push({ pathname: "/thread/[id]", params: { id: item.id } })} />}
            ListEmptyComponent={<EmptyState icon="search" title="No matches" body={`Nothing found for "${q}".`} />} />
        )}
    </View>
  );
}
