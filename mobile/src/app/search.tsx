import { useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { Banner, Button, EmptyState, Icon, Loading } from "@/components/ui";
import { g } from "@/components/grouped";
import { MessageRow } from "@/components/message-row";
import { useAgents, useSearch, useTasks } from "@/lib/queries";
import { searchCache, useOffline } from "@/lib/offline";
import { kv } from "@/lib/kv";
import { pushRecent, readRecent, saveRecent } from "@/lib/recent-search";
import { tick } from "@/lib/haptics";
import { FEATURES } from "@/config";
import {
  TYPE_ICON, canSearch, choiceOf, cleanQuery, correctedLine, countsByChoice, itemLabel, phoneTarget, visibleChoices,
  type SearchGroup, type SearchItem, type TypeChoice,
} from "@/lib/global-search";
import { openWebPath, plainProblem, useGlobalSearch } from "@/lib/docs-queries";
import type { MessageSummary } from "@/api/types";
import { colors, space } from "@/theme";

/**
 * R36, M1: one search across everything the person can open, the same as the web's (mail, tasks, docs, chat, contacts,
 * files and notes where the workspace has them), typo tolerant as the server is. Type chips narrow it, results come
 * grouped with counts, and each opens its phone screen (or the web for kinds the phone has no screen for).
 * Recent searches stay on this phone. With no connection it searches the mail saved on the phone, as before.
 */
export default function Search() {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [choice, setChoice] = useState<TypeChoice>("all");
  const [recent, setRecent] = useState<string[]>([]);
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  useEffect(() => { const t = setTimeout(() => setQ(cleanQuery(text)), 300); return () => clearTimeout(t); }, [text]);
  useEffect(() => { readRecent(kv()).then(setRecent); }, []);
  const offline = useOffline();
  const all = useGlobalSearch(q, "all", !offline);
  const one = useGlobalSearch(q, choice, !offline && choice !== "all");
  const res = choice === "all" ? all : one;
  const netDown = (e: unknown) => (e as { status?: number } | null)?.status === 0;
  // An older server without global search (404): search mail and the tasks on the phone, as before.
  const fallback = (all.error as { status?: number } | null)?.status === 404;
  const mailOnly = useSearch(fallback ? q : "");
  const agents = useAgents();
  const tasks = useTasks();
  const [cachedHits, setLocal] = useState<MessageSummary[] | null>(null);

  // No connection: search what's already on the phone.
  const wantLocal = canSearch(q) && (offline || netDown(all.error));
  useEffect(() => { if (wantLocal) searchCache(kv(), q).then(setLocal); }, [q, wantLocal]);
  const local = wantLocal ? cachedHits : null;

  const remember = () => { const next = pushRecent(recent, cleanQuery(text) || q); if (next !== recent) { setRecent(next); saveRecent(kv(), next); } };
  const use = (s: string) => { tick(); setText(s); setQ(cleanQuery(s)); input.current?.blur(); };
  const clearRecent = () => { tick(); setRecent([]); saveRecent(kv(), []); };
  const pick = (c: TypeChoice) => { tick(); setChoice(c); };

  const groups: SearchGroup[] = res.data?.groups ?? [];
  const found = useMemo(() => (all.data?.groups ?? []).map((x) => x.type), [all.data]);
  const counts = useMemo(() => countsByChoice(all.data?.groups ?? []), [all.data]);
  const chips = visibleChoices(found, choice);
  const fixed = correctedLine(res.data);

  const open = (it: SearchItem) => {
    remember();
    const t = phoneTarget(it);
    if (t.kind === "screen") router.push({ pathname: t.pathname as never, params: t.params });
    else void openWebPath(t.path);
  };

  // The old screen's local task match, used only when the server has no global search.
  const taskHits = useMemo(() => {
    if (!fallback || !FEATURES.tasks || !canSearch(q)) return [];
    const n = q.toLowerCase();
    return (tasks.data ?? []).filter((t) => t.title.toLowerCase().includes(n) || t.ref.toLowerCase() === n).slice(0, 5);
  }, [fallback, tasks.data, q]);

  const body = () => {
    if (!canSearch(q)) {
      return recent.length ? (
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
                style={({ pressed }) => [st.row, i > 0 && st.sepTop, pressed && { backgroundColor: colors.hover }]}>
                <Icon name="clock" size={18} color={colors.subtle} />
                <Text style={{ color: colors.fg, fontSize: 17, flex: 1 }} numberOfLines={1}>{r}</Text>
                <Icon name="corner-up-left" size={16} color={colors.subtle} />
              </Pressable>
            ))}
          </View>
        </ScrollView>
      ) : <EmptyState icon="search" title="Search everything" body="Type at least two letters. Mail, tasks, docs, chat and contacts you can open, typos and all." />;
    }
    // Offline, or the server has no global search: mail (and tasks) the old way.
    if (local || fallback) {
      const mail = local ?? mailOnly.data?.messages ?? [];
      if (!local && mailOnly.isPending && !taskHits.length) return <Loading label="Searching" />;
      if (!mail.length && !taskHits.length) return <EmptyState icon="search" title="No matches" body={`Nothing found for "${q}". Try a name, an address or fewer words.`} />;
      return (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: space.xxl * 2 }}>
          {taskHits.length ? (
            <>
              <Group icon="check-square" title="Tasks" count={taskHits.length} />
              <View style={g.group}>
                {taskHits.map((t, i) => (
                  <Pressable key={t.id} onPress={() => { remember(); router.push({ pathname: "/task/[id]", params: { id: t.id } }); }} accessibilityRole="button"
                    accessibilityLabel={`Task ${t.ref}, ${t.title}`} testID={`search-task-${t.id}`}
                    style={({ pressed }) => [st.row, i > 0 && st.sepTop, pressed && { backgroundColor: colors.hover }]}>
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
          ) : null}
        </ScrollView>
      );
    }
    if (res.isPending) return <Loading label="Searching" />;
    if (res.error && !res.data) {
      return <EmptyState icon="alert-circle" title="Search didn't finish" body={plainProblem(res.error, "Search didn't answer. Try again.")} action={<Button label="Try again" variant="secondary" onPress={() => res.refetch()} testID="search-retry" />} />;
    }
    if (!groups.length) return <EmptyState icon="search" title="No matches" body={`Nothing found for "${q}"${choice !== "all" ? " in this type" : ""}. Try other words${choice !== "all" ? " or All" : ""}.`} />;
    return (
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: space.xxl * 2 }} testID="search-results">
        {fixed ? <Text style={st.fixed} testID="search-corrected">{fixed}</Text> : null}
        {res.data?.partial ? <Text style={st.fixed}>Some results took too long and are left out. Try more words.</Text> : null}
        {groups.map((grp) => (
          <View key={grp.type}>
            <Group icon={TYPE_ICON[grp.type]} title={grp.label} count={grp.items.length} />
            <View style={g.group}>
              {grp.items.map((it, i) => (
                <Pressable key={`${it.type}-${it.id}`} onPress={() => open(it)} accessibilityRole="button" accessibilityLabel={itemLabel(it, grp.label)} testID={`search-${it.type}-${it.id}`}
                  style={({ pressed }) => [st.row, i > 0 && st.sepTop, pressed && { backgroundColor: colors.hover }]}>
                  <Icon name={TYPE_ICON[it.type]} size={20} color={colors.subtle} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.fg, fontSize: 16 }} numberOfLines={1}>{it.title || "Untitled"}</Text>
                    {it.subtitle ? <Text style={{ color: colors.subtle, fontSize: 13 }} numberOfLines={1}>{it.subtitle}</Text> : null}
                    {it.snippet ? <Text style={{ color: colors.muted, fontSize: 14 }} numberOfLines={2}>{it.snippet}</Text> : null}
                  </View>
                  <Icon name={phoneTarget(it).kind === "web" ? "external-link" : "chevron-right"} size={16} color={colors.subtle} />
                </Pressable>
              ))}
            </View>
            {choice === "all" && choiceOf(grp.type) !== "all" && grp.items.length >= 5 ? (
              <Pressable onPress={() => pick(choiceOf(grp.type))} accessibilityRole="button" accessibilityLabel={`Show more ${grp.label}`} style={st.more} testID={`search-more-${grp.type}`}>
                <Text style={{ color: colors.brand, fontSize: 15 }}>Show more {grp.label.toLowerCase()}</Text>
              </Pressable>
            ) : null}
          </View>
        ))}
      </ScrollView>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm }}>
        <View style={st.field}>
          <Icon name="search" size={20} color={colors.subtle} />
          <TextInput ref={input} testID="search" value={text} onChangeText={setText} autoFocus placeholder="Mail, tasks, docs, people"
            placeholderTextColor={colors.subtle} selectionColor={colors.brand} accessibilityLabel="Search" returnKeyType="search" autoCapitalize="none" autoCorrect={false} onSubmitEditing={remember}
            style={st.input} />
          {text ? (
            <Pressable onPress={() => { tick(); setText(""); setQ(""); setChoice("all"); input.current?.focus(); }} accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={10} testID="search-clear">
              <Icon name="x" size={18} color={colors.subtle} />
            </Pressable>
          ) : null}
        </View>
      </View>
      {canSearch(q) && !local && !fallback && chips.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={st.chips} accessibilityRole="tablist" accessibilityLabel="Result types">
          {chips.map((c) => {
            const n = c.id === "all" ? undefined : counts[c.id];
            const on = c.id === choice;
            return (
              <Pressable key={c.id} onPress={() => pick(c.id)} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={n ? `${c.label}, ${n} results` : c.label}
                style={[st.chip, on && { backgroundColor: colors.brandSoft, borderColor: colors.brandLine }]} testID={`search-chip-${c.id}`}>
                <Text style={{ color: on ? colors.brandHover : colors.muted, fontWeight: "600", fontSize: 14 }}>{c.label}</Text>
                {n ? <Text style={{ color: on ? colors.brand : colors.subtle, fontSize: 13 }}>{n}{n >= 5 ? "+" : ""}</Text> : null}
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      {local ? <Banner text="Offline. Searching mail saved on this phone." /> : null}
      {body()}
    </View>
  );
}

function Group({ icon, title, count }: { icon: (typeof TYPE_ICON)[keyof typeof TYPE_ICON]; title: string; count: number }) {
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
  row: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: colors.surface },
  sepTop: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.lineStrong },
  chips: { paddingHorizontal: space.lg, paddingBottom: space.sm, gap: space.sm },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 36, paddingHorizontal: space.md, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong, backgroundColor: colors.surface },
  fixed: { color: colors.subtle, fontSize: 14, marginHorizontal: space.xl, marginTop: space.md },
  more: { minHeight: 44, justifyContent: "center", marginHorizontal: space.xl },
});
