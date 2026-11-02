import { useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { Banner, Button, EmptyState, Icon, Loading } from "@/components/ui";
import { useSession } from "@/lib/session";
import { useOffline } from "@/lib/offline";
import { tick } from "@/lib/haptics";
import { noAccess, treeRows, type TreeRow } from "@/lib/docs";
import { openWebPath, plainProblem, useDocTree } from "@/lib/docs-queries";
import { colors, space } from "@/theme";

/**
 * M1: Docs on the phone. The workspace's pages as the web's tree (folders are pages with pages inside), a search over
 * titles, and a native read only reader. Workspace members only: the server answers the tree only to them.
 */
export default function Docs() {
  const { me } = useSession();
  const member = !!me?.organization;
  const tree = useDocTree(member);
  const offline = useOffline();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [pulling, setPulling] = useState(false);
  const rows = useMemo(() => treeRows(tree.data?.tree ?? [], { open, query }), [tree.data, open, query]);

  if (!member) return <EmptyState icon="lock" title="No access to Docs" body="Docs are for members of a workspace. Ask an admin to invite you." />;
  if (tree.isPending) return <Loading label="Loading docs" rows={8} variant="task" />;
  if (tree.error && !tree.data) {
    return noAccess(tree.error)
      ? <EmptyState icon="lock" title="No access to Docs" body="You don't have access to this workspace's docs." />
      : <EmptyState icon="alert-circle" title="Couldn't load docs" body={plainProblem(tree.error)} action={<Button label="Try again" variant="secondary" onPress={() => tree.refetch()} testID="docs-retry" />} />;
  }

  const toggle = (id: string) => { tick(); setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }); };
  const refresh = async () => { setPulling(true); try { await tree.refetch(); } finally { setPulling(false); } };
  const total = tree.data?.count ?? 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm }}>
        <View style={st.field}>
          <Icon name="search" size={20} color={colors.subtle} />
          <TextInput value={query} onChangeText={setQuery} placeholder="Search page titles" placeholderTextColor={colors.subtle} selectionColor={colors.brand}
            accessibilityLabel="Search page titles" autoCapitalize="none" autoCorrect={false} returnKeyType="search" style={st.input} testID="docs-search" />
          {query ? (
            <Pressable onPress={() => setQuery("")} accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={10} testID="docs-search-clear">
              <Icon name="x" size={18} color={colors.subtle} />
            </Pressable>
          ) : null}
        </View>
      </View>
      {offline ? <Banner text="Offline. Showing the docs last loaded." /> : null}
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={refresh} tintColor={colors.subtle} />}
        contentContainerStyle={{ paddingBottom: space.xxl * 2, flexGrow: 1 }}
        ListHeaderComponent={rows.length ? <Text style={st.count}>{query ? `${rows.length} matching` : `${total} ${total === 1 ? "page" : "pages"}`}</Text> : undefined}
        ListEmptyComponent={query
          ? <EmptyState icon="search" title="No matching pages" body={`No page title has "${query.trim()}". Global search also looks inside pages.`} />
          : <EmptyState icon="file-text" title="No docs yet" body="Pages made on the web show here, ready to read." action={<Button label="Open Docs on the web" variant="secondary" onPress={() => openWebPath("/app/docs")} testID="docs-web" />} />}
        renderItem={({ item, index }) => <DocRow r={item} first={index === 0} open={open.has(item.id) || !!query} onToggle={() => toggle(item.id)} />}
        ListFooterComponent={tree.data?.truncated ? <Text style={st.foot}>Showing the first {total} pages. Open Docs on the web to see the rest.</Text> : undefined}
      />
    </View>
  );
}

function DocRow({ r, first, open, onToggle }: { r: TreeRow; first: boolean; open: boolean; onToggle: () => void }) {
  const indent = Math.min(r.depth, 5) * 18;
  return (
    <View style={[st.row, !first && st.sepTop]}>
      <Pressable onPress={() => router.push({ pathname: "/doc/[id]", params: { id: r.id } })} accessibilityRole="button"
        accessibilityLabel={`${r.title}${r.kind === "whiteboard" ? ", whiteboard" : ""}${r.path.length ? `, in ${r.path.join(", ")}` : ""}`} testID={`doc-row-${r.id}`}
        style={({ pressed }) => [st.main, { paddingLeft: space.lg + indent }, pressed && { backgroundColor: colors.hover }]}>
        <Icon name={r.kind === "whiteboard" ? "edit-3" : r.hasChildren ? "layers" : "file-text"} size={20} color={colors.subtle} />
        <Text style={{ color: colors.fg, fontSize: 17, flex: 1 }} numberOfLines={1}>{r.title}</Text>
      </Pressable>
      {r.hasChildren ? (
        <Pressable onPress={onToggle} accessibilityRole="button" accessibilityLabel={`${open ? "Hide" : "Show"} pages in ${r.title}`} accessibilityState={{ expanded: open }}
          style={st.toggle} testID={`doc-toggle-${r.id}`}>
          <Icon name={open ? "chevron-down" : "chevron-right"} size={18} color={colors.subtle} />
        </Pressable>
      ) : <View style={st.toggle} />}
    </View>
  );
}

const st = StyleSheet.create({
  field: { flexDirection: "row", alignItems: "center", gap: space.sm, height: 44, borderRadius: 12, paddingHorizontal: space.md, backgroundColor: colors.elevated },
  input: { flex: 1, color: colors.fg, fontSize: 17, height: 44 },
  count: { color: colors.subtle, fontSize: 13, marginHorizontal: space.xl, marginTop: space.sm, marginBottom: 7 },
  row: { flexDirection: "row", alignItems: "center", backgroundColor: colors.surface },
  main: { flex: 1, minHeight: 48, flexDirection: "row", alignItems: "center", gap: space.md, paddingRight: space.sm, paddingVertical: space.sm },
  toggle: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  sepTop: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.lineStrong },
  foot: { color: colors.subtle, fontSize: 13, marginHorizontal: space.xl, marginTop: space.md },
});
