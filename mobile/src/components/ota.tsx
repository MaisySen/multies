/**
 * The three update surfaces (docs/OTA.md): the blocking "update from the store" screen for a store
 * build below the server's minimum, the small notice before a critical update restarts the app, and
 * the "What's new" sheet shown once after an update.
 */
import { Linking, Modal, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Icon } from "@/components/ui";
import { colors, font, space } from "@/theme";
import type { WhatsNewItem } from "@/lib/ota/whats-new.generated";
import { bundles, tr } from "@/i18n";

/** MFIX1: an item in the language on screen when its words exist (m.wn.<version>.<i>), else the changelog English. */
export function whatsNewText(version: string, i: number, it: WhatsNewItem): WhatsNewItem {
  const k = `m.wn.${version}.${i}`;
  return bundles.en[`${k}.body`] ? { title: tr(`${k}.title`), body: tr(`${k}.body`) } : it;
}

export function StoreUpdateScreen({ storeUrl, os, message }: { storeUrl: string | null; os: "ios" | "android"; message?: string | null }) {
  const store = os === "ios" ? "the App Store" : "Google Play";
  return (
    <View testID="store-update" style={{ flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center", padding: space.xl, gap: space.lg }}>
      <View style={{ width: 64, height: 64, borderRadius: 16, backgroundColor: colors.brandSoft, alignItems: "center", justifyContent: "center" }}>
        <Icon name="download" size={30} color={colors.brand} />
      </View>
      <Text accessibilityRole="header" style={[font.heading, { fontSize: 22, textAlign: "center" }]}>Update Multies to continue</Text>
      <Text style={[font.body, { textAlign: "center", color: colors.muted }]}>
        {message || `This version of Multies is no longer supported. Get the latest version from ${store}; your mail and tasks are kept.`}
      </Text>
      {storeUrl ? (
        <Button testID="store-update-open" label={os === "ios" ? "Open the App Store" : "Open Google Play"} icon="external-link" onPress={() => { Linking.openURL(storeUrl).catch(() => {}); }} style={{ alignSelf: "stretch" }} />
      ) : null}
    </View>
  );
}

export function CriticalUpdateNotice({ text }: { text: string }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      testID="critical-update-notice"
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      pointerEvents="none"
      style={{ position: "absolute", left: space.lg, right: space.lg, top: insets.top + space.sm, flexDirection: "row", gap: space.sm, alignItems: "center", padding: space.md, borderRadius: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 4 }}
    >
      <Icon name="refresh-cw" size={18} color={colors.brand} />
      <Text style={[font.small, { flex: 1, color: colors.fg }]}>{text}</Text>
    </View>
  );
}

export function WhatsNewSheet({ version, items, onClose }: { version: string; items: WhatsNewItem[]; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose} testID="whats-new">
      <View style={{ flex: 1, backgroundColor: colors.bg, paddingBottom: insets.bottom + space.lg }}>
        <ScrollView contentContainerStyle={{ padding: space.xl, gap: space.lg }}>
          <Text accessibilityRole="header" style={[font.heading, { fontSize: 28 }]}>{tr("m.wn.heading")}</Text>
          <Text style={[font.small, { color: colors.muted, marginTop: -space.sm }]}>Multies {version}</Text>
          {items.map((raw, i) => { const it = whatsNewText(version, i, raw); return (
            <View key={i} style={{ flexDirection: "row", gap: space.md }} testID={`whats-new-item-${i}`}>
              <View style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: colors.brandSoft, alignItems: "center", justifyContent: "center" }}>
                <Icon name="check" size={18} color={colors.brand} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                {it.title ? <Text style={[font.body, { fontWeight: "600", color: colors.fg }]}>{it.title}</Text> : null}
                <Text style={[font.small, { color: colors.muted }]}>{it.body}</Text>
              </View>
            </View>
          ); })}
        </ScrollView>
        <View style={{ paddingHorizontal: space.xl }}>
          <Button testID="whats-new-continue" label={tr("m.wn.continue")} onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

