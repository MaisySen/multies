/**
 * M2 (1.10.10): More, a grid of the web's menu sections with counts (GET /api/nav/menu, web R121). A tile opens its
 * section: the pages the server lists for this person, each in its app screen where one exists, else the web page in
 * the in-app browser. People can hide sections on this phone (Edit) and show them all again (Reset). When the server
 * has no menu the grid shows what the app can open today, with a note and Retry.
 */
import { useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Banner, Button, EmptyState, Icon, LargeTitle, Skeleton, TILE } from "@/components/ui";
import { useCounts } from "@/lib/queries";
import { useHiddenSections, useNavMenu, type MenuProblem } from "@/lib/nav-menu-queries";
import { canHide, colorFor, countText, iconFor, sectionCount, type MenuSection } from "@/lib/nav-menu";
import { tick } from "@/lib/haptics";
import { colors, font, radius, space, TOUCH } from "@/theme";

const NOTE: Record<Exclude<MenuProblem, null>, string> = {
  old: "Showing what this app can open. Your full menu shows once the server is updated.",
  offline: "You're offline. Showing your last menu.",
  error: "Couldn't load your menu. Showing what this app can open.",
};

export function columnsFor(width: number) { return width >= 600 ? 4 : 3; }

function Tile({ s, n, width, editing, hidden, onPress, onToggle }: {
  s: MenuSection; n: number; width: number; editing: boolean; hidden: boolean; onPress: () => void; onToggle: () => void;
}) {
  const hideable = canHide(s.id);
  const label = editing
    ? (hideable ? `${hidden ? "Show" : "Hide"} ${s.label}` : `${s.label}, always shown`)
    : n > 0 ? `${s.label}, ${n} new` : s.label;
  return (
    <Pressable testID={`more-tile-${s.id}`} accessibilityRole="button" accessibilityLabel={label}
      accessibilityState={editing && hideable ? { selected: !hidden } : undefined}
      disabled={editing && !hideable}
      onPress={() => { tick(); if (editing) onToggle(); else onPress(); }}
      style={({ pressed }) => [{
        width, minHeight: 96, padding: space.md, borderRadius: radius.lg, backgroundColor: colors.surface, gap: space.sm,
        justifyContent: "space-between", opacity: editing && hidden ? 0.45 : 1, borderWidth: 1, borderColor: colors.line,
      }, pressed && { backgroundColor: colors.hover }]}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" }}>
        <View style={{ width: 34, height: 34, borderRadius: 9, backgroundColor: TILE[colorFor(s.id)], alignItems: "center", justifyContent: "center" }}>
          <Icon name={iconFor(s.icon)} size={19} color="#FFFFFF" filled />
        </View>
        {editing ? (hideable ? <Icon name={hidden ? "plus" : "check-circle"} size={20} color={hidden ? colors.subtle : colors.brand} /> : <Icon name="lock" size={16} color={colors.subtle} />)
          : n > 0 ? (
            <View testID={`more-count-${s.id}`} style={{ minWidth: 22, height: 22, paddingHorizontal: 6, borderRadius: 11, backgroundColor: colors.badge, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ color: "#FFFFFF", fontSize: 12, fontWeight: "700" }}>{countText(n)}</Text>
            </View>
          ) : null}
      </View>
      <Text style={[font.body, { color: colors.fg, fontWeight: "600", fontSize: width < 112 ? 13 : 15, lineHeight: width < 112 ? 17 : 20, letterSpacing: width < 112 ? -0.1 : -0.24 }]} numberOfLines={2} maxFontSizeMultiplier={1.3}>{s.label}</Text>
    </Pressable>
  );
}

export default function More() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const q = useNavMenu();
  const counts = useCounts();
  const { hidden, toggle, reset } = useHiddenSections();
  const [editing, setEditing] = useState(false);
  const cols = columnsFor(width);
  const gap = space.md;
  const tileW = Math.floor((Math.min(width, 900) - space.lg * 2 - gap * (cols - 1)) / cols);
  const state = q.data;
  const all = state?.menu.sections ?? [];
  const shown = editing ? all : all.filter((s) => !canHide(s.id) || !hidden.includes(s.id));
  const liveCounts = state?.problem === "offline" ? null : counts.data;

  const right = state && all.length ? (
    <View style={{ flexDirection: "row", gap: space.sm }}>
      {editing && hidden.length ? <Button label="Reset" variant="secondary" onPress={reset} testID="more-reset" accessibilityHint="Shows every section again" /> : null}
      <Button label={editing ? "Done" : "Edit"} variant={editing ? "primary" : "secondary"} onPress={() => setEditing((v) => !v)} testID="more-edit"
        accessibilityHint={editing ? undefined : "Choose which sections show here"} />
    </View>
  ) : null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="more-screen">
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); counts.refetch(); }} tintColor={colors.muted} />}>
        <LargeTitle title="More" top={insets.top} right={right} subtitle={editing ? "Tap a section to hide or show it" : null} />
        {q.isPending ? (
          <View testID="more-loading" accessibilityLabel="Loading your menu" accessible style={{ flexDirection: "row", flexWrap: "wrap", gap, paddingHorizontal: space.lg, paddingTop: space.sm }}>
            {Array.from({ length: 9 }, (_, i) => <Skeleton key={i} width={tileW} height={96} radius={radius.lg} />)}
          </View>
        ) : q.isError || !state ? (
          <EmptyState icon="alert-circle" title="Couldn't load your menu" body="Check your connection and try again."
            action={<Button label="Retry" onPress={() => q.refetch()} testID="more-retry" />} />
        ) : !shown.length ? (
          <EmptyState icon="layers" title="Nothing to show yet" body="Your workspace has no sections for you right now."
            action={<Button label="Retry" onPress={() => q.refetch()} testID="more-retry" />} />
        ) : (
          <>
            {state.problem ? (
              <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm, gap: space.sm }} testID={`more-note-${state.problem}`}>
                <Banner tone={state.problem === "offline" ? "warn" : "neutral"} icon={state.problem === "offline" ? "wifi-off" : "info"} text={NOTE[state.problem]} />
                {state.problem !== "old" ? <Button label="Retry" variant="secondary" onPress={() => q.refetch()} testID="more-retry" /> : null}
              </View>
            ) : null}
            <View testID="more-grid" style={{ flexDirection: "row", flexWrap: "wrap", gap, paddingHorizontal: space.lg, paddingTop: space.sm }}>
              {shown.map((s) => (
                <Tile key={s.id} s={s} n={sectionCount(s, liveCounts)} width={tileW} editing={editing} hidden={hidden.includes(s.id)}
                  onToggle={() => toggle(s.id)}
                  onPress={() => router.push({ pathname: "/more/[section]", params: { section: s.id } })} />
              ))}
            </View>
            {!editing && hidden.length ? (
              <Pressable onPress={() => setEditing(true)} accessibilityRole="button" testID="more-hidden-note" style={{ minHeight: TOUCH, justifyContent: "center", paddingHorizontal: space.lg, marginTop: space.md }}>
                <Text style={[font.tiny, { color: colors.subtle }]}>{hidden.length === 1 ? "1 section hidden. Tap to edit." : `${hidden.length} sections hidden. Tap to edit.`}</Text>
              </Pressable>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}
