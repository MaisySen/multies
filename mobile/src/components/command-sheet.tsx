import { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { closeCommandSheet, useCommandSheetOpen } from "@/lib/command-sheet-store";
import { commandsFor, createHandlers, searchCommands, type Command } from "@/lib/commands";
import { useFilesAccess } from "@/lib/drive-queries";
import { useReduceMotion } from "@/lib/motion";
import { tick } from "@/lib/haptics";
import { Icon } from "./ui";
import { colors, radius, space, TOUCH } from "@/theme";
import { openAppPath } from "@/lib/web-open";

/**
 * R31: the command sheet, the phone's version of the web command menu. Same command ids and titles
 * as the registry; type to filter, tap to run. Opened from the header button or a long-press on
 * any tab.
 */
export function CommandSheet() {
  const visible = useCommandSheetOpen();
  const [q, setQ] = useState("");
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  const files = useFilesAccess();
  // M1: Files only where the web has it on and the session is a workspace member.
  const all = useMemo(() => commandsFor(["go", "app"]).filter((c) => c.id !== "files" || files.on), [files.on]);
  const list = useMemo(() => searchCommands(q, all), [q, all]);
  const handlers = useMemo(() => createHandlers({
    navigate: (href) => router.push(href as never),
    openWeb: (path) => { void openAppPath(path); },
  }), []);
  const close = () => { setQ(""); closeCommandSheet(); };
  const run = (c: Command) => { tick(); close(); setTimeout(() => handlers[c.id]({}), 0); };

  return (
    <Modal visible={visible} transparent animationType={reduce ? "none" : "fade"} onRequestClose={close} statusBarTranslucent>
      <Pressable style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: "rgba(0,0,0,0.35)" }} onPress={close} accessibilityLabel="Close" accessibilityRole="button" />
      <View accessibilityViewIsModal testID="command-sheet"
        style={{ marginTop: insets.top + space.xl, marginHorizontal: space.md, backgroundColor: colors.surface, borderRadius: radius.lg + 2, overflow: "hidden", maxHeight: "75%",
          shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 20, shadowOffset: { width: 0, height: 8 }, elevation: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, borderBottomWidth: 1, borderBottomColor: colors.line }}>
          <Icon name="search" size={18} color={colors.subtle} />
          <TextInput value={q} onChangeText={setQ} autoFocus placeholder="Type a command or a page" placeholderTextColor={colors.subtle}
            accessibilityLabel="Search commands" autoCorrect={false} autoCapitalize="none" returnKeyType="go" testID="command-search"
            onSubmitEditing={() => { if (list[0]) run(list[0]); }}
            style={{ flex: 1, color: colors.fg, fontSize: 17, minHeight: TOUCH + 8 }} />
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingVertical: space.xs }}>
          {list.length ? list.map((c) => (
            <Pressable key={c.id} onPress={() => run(c)} accessibilityRole="button" accessibilityLabel={c.title} testID={`command-${c.id}`}
              style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TOUCH + 4, paddingHorizontal: space.lg, backgroundColor: pressed ? colors.hover : "transparent" })}>
              <View style={{ width: 30, height: 30, borderRadius: radius.sm + 2, backgroundColor: colors.brandSoft, alignItems: "center", justifyContent: "center" }}>
                <Icon name={c.icon} size={16} color={colors.brand} />
              </View>
              <Text style={{ flex: 1, color: colors.fg, fontSize: 16 }} numberOfLines={1}>{c.title}</Text>
              {c.web ? <Text style={{ color: colors.subtle, fontSize: 12, fontVariant: ["tabular-nums"] }} accessibilityElementsHidden importantForAccessibility="no">{c.web.join(" ")}</Text> : null}
            </Pressable>
          )) : <Text style={{ color: colors.subtle, fontSize: 15, padding: space.lg }}>No command matches.</Text>}
        </ScrollView>
      </View>
    </Modal>
  );
}
