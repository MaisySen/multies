import { useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { Banner, EmptyState, Icon, Loading } from "@/components/ui";
import { g } from "@/components/grouped";
import { MessageRow } from "@/components/message-row";
import { useAgents, useSearch, useTasks } from "@/lib/queries";
import { searchCache, useOffline } from "@/lib/offline";
import { kv } from "@/lib/kv";
import { pushRecent, readRecent, saveRecent } from "@/lib/recent-search";
import { tick } from "@/lib/haptics";
import { FEATURES } from "@/config";
import type { MessageSummary } from "@/api/types";
import { colors, space } from "@/theme";

/**
 * R36: a large search field with a clear button, recent searches kept on this phone, and results
 * grouped by type (tasks from the list already on the phone, then mail from the server), each
 * group with its icon and count, and a clear no result state.
 */
export default function Search() {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  useEffect(() => { const t = setTimeout(() => setQ(text.trim()), 300); return () => clearTimeout(t); }, [text]);
  useEffect(() => { readRecent(kv()).then(setRecent); }, []);
  const res = useSearch(q);
  const agents = useAgents();
  const tasks = useTasks();
  const offline = useOffline();
  const [local, setLocal] = useState<MessageSummary[] | null>(null);

  // No connection: search what's already on the phone.
  useEffect(() => {
    if (q.length >= 2 && (offline || (res.error as { status?: number } | null)?.status === 0)) searchCache(kv(), q).then(setLocal);
    else setLocal(null);
  }, [q, offline, res.error]);

  // Remember a search when it is sent from the keyboard or one of its results is opened.
  const remember = () => { const next = pushRecent(recent, text.trim() || q); if (next !== recent) { setRecent(next); saveRecent(kv(), next); } };

  const mail = local ?? res.data?.messages ?? [];
  const taskHits = useMemo(() => {
    if (!FEATURES.tasks || q.length < 2) return [];
    const n = q.toLowerCase();
    return (tasks.data ?? []).filter((t) => t.title.toLowerCase().includes(n) || t.ref.toLowerCase() === n).slice(0, 5);
  }, [tasks.data, q]);
  const use = (s: string) => { tick(); setText(s); setQ(s); input.current?.blur(); };
  const clearRecent = () => { tick(); setRecent([]); saveRecent(kv(), []); };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm }}>
        <View style={st.field}>
          <Icon name="search" size={20} color={colors.subtle} />
          <TextInput ref={input} testID="search" value={text} onChangeText={setText} autoFocus placeholder="People, subjects, words in the message"
            placeholderTextColor={colors.subtle} selectionColor={colors.brand} accessibilityLabel="Search" returnKeyType="search" autoCapitalize="none" autoCorrect={false} onSubmitEditing={remember}
            style={st.input} />
          {text ? (
            <Pressable onPress={() => { tick(); setText(""); setQ(""); input.current?.focus(); }} accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={10} testID="search-clear">
              <Icon name="x" size={18} color={colors.subtle} />
            </Pressable>
          ) : null}
        </View>
      </View>
      {local ? <Banner text="Offline. Searching mail saved on this phone." /> : null}
      {q.length < 2 ? (
        recent.length ? (
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingTop: space.sm }}>
            <View style={st.headRow}>
              <Text style={[g.header, { marginHorizontal: 0, marginBottom: 0, flex: 1 }]} accessibilityRole="header">Recent</Text>
              <Pressable onPress={clearRecent} accessibilityRole="button" accessibilityLabel="Clear recent searches" hitSlop={8} testID="recent-clear">
                <Text style={{ color: colors.brand, fontSize: 15 }}>Clear</Text>
              </Pressable>
            </View>
            <View style={g.group}>
              {recent.map((r, i) => (
                <Pressable key={r} onPress={() => use(r)} accessibilityRole="button" accessibilityLabel={`Search for ${r}`} testID={`recent-${i}`}
                  style={({ pressed }) => [st.recent, i > 0 && st.sepTop, pressed && { backgroundColor: colors.hover }]}>
                  <Icon name="clock" size={18} color={colors.subtle} />
                  <Text style={{ color: colors.fg, fontSize: 17, flex: 1 }} numberOfLines={1}>{r}</Text>
                  <Icon name="corner-up-left" size={16} color={colors.subtle} />
                </Pressable>
              ))}
            </View>
          </ScrollView>
        ) : <EmptyState icon="search" title="Search your mail" body="Type at least two letters. Results come from every mailbox you can open, and your tasks." />
      ) : res.isPending && !local && !taskHits.length ? <Loading label="Searching" />
        : !mail.length && !taskHits.length ? (
          <EmptyState icon="search" title="No matches" body={`Nothing found for "${q}". Try a name, an address or fewer words.`} />
        ) : (
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: space.xxl * 2 }}>
            {taskHits.length ? (
              <>
                <Group icon="check-square" title="Tasks" count={taskHits.length} />
                <View style={g.group}>
                  {taskHits.map((t, i) => (
                    <Pressable key={t.id} onPress={() => { remember(); router.push({ pathname: "/task/[id]", params: { id: t.id } }); }} accessibilityRole="button"
                      accessibilityLabel={`Task ${t.ref}, ${t.title}`} testID={`search-task-${t.id}`}
                      style={({ pressed }) => [st.recent, i > 0 && st.sepTop, pressed && { backgroundColor: colors.hover }]}>
                      <Icon name={t.status === "done" ? "check-circle" : "circle"} size={20} color={t.status === "done" ? colors.ok : colors.subtle} filled={t.status === "done"} />
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: colors.fg, fontSize: 16 }} numberOfLines={1}>{t.title}</Text>
                        <Text style={{ color: colors.subtle, fontSize: 13 }}>{t.ref}{t.statusName ? `, ${t.statusName}` : ""}</Text>
                      </View>
                      <Icon name="chevron-right" size={16} color={colors.subtle} />
                    </Pressable>
                  ))}
                </View>
              </>
            ) : null}
            {mail.length ? (
              <>
                <Group icon="mail" title="Mail" count={mail.length} />
                {mail.map((item) => <MessageRow key={item.id} m={item} agents={agents.data} onPress={() => { remember(); router.push({ pathname: "/thread/[id]", params: { id: item.id } }); }} />)}
              </>
            ) : res.isPending && !local ? <Loading label="Searching mail" rows={3} /> : null}
          </ScrollView>
        )}
    </View>
  );
}

function Group({ icon, title, count }: { icon: "mail" | "check-square"; title: string; count: number }) {
  return (
    <View style={[st.headRow, { marginTop: space.lg }]} accessibilityRole="header" accessibilityLabel={`${title}, ${count}`}>
      <Icon name={icon} size={15} color={colors.subtle} />
      <Text style={[g.header, { marginHorizontal: 0, marginBottom: 0, flex: 1 }]}>{title}</Text>
      <Text style={{ color: colors.subtle, fontSize: 13 }}>{count}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  field: { flexDirection: "row", alignItems: "center", gap: space.sm, height: 44, borderRadius: 12, paddingHorizontal: space.md, backgroundColor: colors.elevated },
  input: { flex: 1, color: colors.fg, fontSize: 17, height: 44 },
  headRow: { flexDirection: "row", alignItems: "center", gap: 6, marginHorizontal: space.xl, marginBottom: 7 },
  recent: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: colors.surface },
  sepTop: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.lineStrong },
});
