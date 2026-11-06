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
import { colors, font, radius, space, TOUCH , lh } from "@/theme";
import { isDevanagari, tl, tr } from "@/i18n";

const NOTE: Record<Exclude<MenuProblem, null>, string> = {
  old: tr("m.more.showing_what_this_app_can_open_your_full_menu_sh"),
  offline: tr("m.more.you_re_offline_showing_your_last_menu"),
  error: tr("m.more.couldn_t_load_your_menu_showing_what_this_app_ca"),
};

export function columnsFor(width: number) { return width >= 600 ? 4 : 3; }

function Tile({ s, n, width, editing, hidden, onPress, onToggle }: {
  s: MenuSection; n: number; width: number; editing: boolean; hidden: boolean; onPress: () => void; onToggle: () => void;
}) {
  const hideable = canHide(s.id);
  const label = editing
    ? (hideable ? (hidden ? tr("m.more.show_label", { label: tl("nav", s.label) }) : tr("m.more.hide_label", { label: tl("nav", s.label) })) : tr("m.more.label_always_shown", { label: tl("nav", s.label) }))
    : n > 0 ? tr("m.more.label_new", { label: tl("nav", s.label), count: n }) : tl("nav", s.label);
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
      <Text style={[font.body, { color: colors.fg, fontWeight: "600", fontSize: width < 112 ? 13 : 15, lineHeight: lh(width < 112 ? 17 : 20), letterSpacing: isDevanagari() ? 0 : width < 112 ? -0.1 : -0.24 }]} numberOfLines={2} maxFontSizeMultiplier={1.3}>{tl("nav", s.label)}</Text>
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
      {editing && hidden.length ? <Button label={tr("m.more.reset")} variant="secondary" onPress={reset} testID="more-reset" accessibilityHint={tr("m.more.shows_every_section_again")} /> : null}
      <Button label={editing ? tr("m.more.done") : tr("m.more.edit")} variant={editing ? "primary" : "secondary"} onPress={() => setEditing((v) => !v)} testID="more-edit"
        accessibilityHint={editing ? undefined : tr("m.more.choose_which_sections_show_here")} />
    </View>
  ) : null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="more-screen">
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); counts.refetch(); }} tintColor={colors.muted} />}>
        <LargeTitle title={tr("m.more.more")} top={insets.top} right={right} subtitle={editing ? tr("m.more.tap_a_section_to_hide_or_show_it") : null} />
        {q.isPending ? (
          <View testID="more-loading" accessibilityLabel={tr("m.more.loading_your_menu")} accessible style={{ flexDirection: "row", flexWrap: "wrap", gap, paddingHorizontal: space.lg, paddingTop: space.sm }}>
            {Array.from({ length: 9 }, (_, i) => <Skeleton key={i} width={tileW} height={96} radius={radius.lg} />)}
          </View>
        ) : q.isError || !state ? (
          <EmptyState icon="alert-circle" title={tr("m.more.couldn_t_load_your_menu")} body={tr("m.more.check_your_connection_and_try_again")}
            action={<Button label={tr("m.more.retry")} onPress={() => q.refetch()} testID="more-retry" />} />
        ) : !shown.length ? (
          <EmptyState icon="layers" title={tr("m.more.nothing_to_show_yet")} body={tr("m.more.your_workspace_has_no_sections_for_you_right_now")}
            action={<Button label={tr("m.more.retry")} onPress={() => q.refetch()} testID="more-retry" />} />
        ) : (
          <>
            {state.problem ? (
              <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm, gap: space.sm }} testID={`more-note-${state.problem}`}>
                <Banner tone={state.problem === "offline" ? "warn" : "neutral"} icon={state.problem === "offline" ? "wifi-off" : "info"} text={NOTE[state.problem]} />
                {state.problem !== "old" ? <Button label={tr("m.more.retry")} variant="secondary" onPress={() => q.refetch()} testID="more-retry" /> : null}
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
                <Text style={[font.tiny, { color: colors.subtle }]}>{tr("m.more.sections_hidden_tap_to_edit", { count: hidden.length })}</Text>
              </Pressable>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}
