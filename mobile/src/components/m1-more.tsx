/**
 * M1 (1.10.9): small pieces the Mail merge, Mail archive and Sync screens share.
 */
import { Alert, Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { Button, EmptyState, Icon } from "./ui";
import { toolFeatureOn, useWebConfig } from "@/lib/web-config";
import { openOnWeb } from "./tool-ui";
import { Footnote } from "./m1-work";
import { colors, font, radius, space, TOUCH } from "@/theme";

/** Asks first, then runs. Cancel does nothing. */
export function confirmThen(title: string, body: string, action: string, run: () => void, destructive = false) {
  Alert.alert(title, body, [
    { text: "Cancel", style: "cancel" },
    { text: action, style: destructive ? "destructive" : "default", onPress: run },
  ]);
}

/** The plain note and button for what stays on the web. */
export function WebNote({ text, path, testID }: { text: string; path: string; testID?: string }) {
  return (
    <View style={{ gap: space.sm, paddingHorizontal: space.lg }}>
      <Footnote>{text}</Footnote>
      <Button label="Open on the web" icon="external-link" variant="secondary" onPress={() => openOnWeb(path)} testID={testID ?? "open-on-web"} />
    </View>
  );
}

/** A feature the workspace has switched off on the server. */
export function FeatureOff({ title, body }: { title: string; body: string }) {
  return <EmptyState icon="lock" title={title} body={body} art={null} />;
}

/** A label and a number, side by side in a row of stats. */
export function StatCell({ value, label, testID }: { value: string; label: string; testID?: string }) {
  return (
    <View style={{ flexGrow: 1, flexBasis: "30%", padding: space.md, gap: 2 }} testID={testID}>
      <Text style={[font.headline, { color: colors.fg }]}>{value}</Text>
      <Text style={font.tiny}>{label}</Text>
    </View>
  );
}

/** The message from a failed request, in plain words. */
export function problemText(e: unknown, fallback = "Something went wrong. Try again."): string {
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string" && (e as { message: string }).message) return (e as { message: string }).message;
  return fallback;
}

/** The Mail merge entry on the Tools screen: shows only where the web shows Tools > Mail merge newsletters. */
export function MailMergeEntry({ hidden }: { hidden?: boolean }) {
  const cfg = useWebConfig();
  if (hidden || !toolFeatureOn(cfg.data, "merge_plus_r109")) return null;
  return (
    <Pressable onPress={() => router.push("/mail-merge")} accessibilityRole="button" accessibilityLabel="Mail merge, newsletters and journeys" testID="tools-mail-merge"
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TOUCH, padding: space.md, borderRadius: radius.md, backgroundColor: pressed ? colors.bg : colors.elevated })}>
      <Icon name="mail" size={20} color={colors.brand} />
      <View style={{ flex: 1 }}>
        <Text style={font.headline}>Mail merge</Text>
        <Text style={font.tiny}>Newsletters and journeys: status, pause and test</Text>
      </View>
      <Icon name="chevron-right" size={18} color={colors.subtle} />
    </Pressable>
  );
}
