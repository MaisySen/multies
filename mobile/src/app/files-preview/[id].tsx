import { useState } from "react";
import { ActivityIndicator, Alert, Image, Pressable, Text, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Icon } from "@/components/ui";
import { space, TOUCH } from "@/theme";
import { driveError } from "@/lib/drive";
import { useDriveIo, useFilesAccess } from "@/lib/drive-queries";
import { imageSource, openDriveFile } from "@/lib/drive-files";

/**
 * M1: an image from Files, full screen on black. The picture loads from the drive's content route with the session
 * cookie on the request. The share button opens it in Quick Look (iPhone) or the matching app (Android) to save or send.
 */
const SAMPLE_IMAGE = require("../../../assets/icon.png");

export default function FilePreview() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const insets = useSafeAreaInsets();
  const access = useFilesAccess();
  const io = useDriveIo();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const src = access.on ? imageSource(io, { id }) : null;
  const title = name || "Image";
  const share = async () => {
    if (!io.auth) { Alert.alert("Open on your phone", "Files open in the app on a phone signed in to Multies."); return; }
    setBusy(true);
    try { await openDriveFile(io, { id, name: title }); } catch (e) { Alert.alert("Couldn't open this file", driveError(e).message); } finally { setBusy(false); }
  };
  return (
    <View style={{ flex: 1, backgroundColor: "#000" }} testID="file-preview">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ paddingTop: insets.top, flexDirection: "row", alignItems: "center", paddingHorizontal: space.sm }}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Close preview" testID="file-preview-close"
          style={{ width: TOUCH, height: TOUCH, alignItems: "center", justifyContent: "center" }}>
          <Icon name="x" size={24} color="#FFFFFF" />
        </Pressable>
        <Text style={{ flex: 1, color: "#FFFFFF", fontSize: 16, fontWeight: "600", textAlign: "center" }} numberOfLines={1} accessibilityRole="header">{title}</Text>
        <Pressable onPress={() => void share()} accessibilityRole="button" accessibilityLabel="Share or save this image" testID="file-preview-share" disabled={busy}
          style={{ width: TOUCH, height: TOUCH, alignItems: "center", justifyContent: "center" }}>
          {busy ? <ActivityIndicator color="#FFFFFF" /> : <Icon name="download" size={22} color="#FFFFFF" />}
        </Pressable>
      </View>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        {!access.on && !access.pending ? (
          <Text style={{ color: "#FFFFFF", fontSize: 16, textAlign: "center", padding: space.xl }}>You do not have access to this.</Text>
        ) : (
          <>
            <Image source={src ?? SAMPLE_IMAGE} resizeMode="contain" accessibilityLabel={title} accessibilityIgnoresInvertColors
              style={{ width: "100%", height: "100%" }} onLoad={() => setState("ready")} onError={() => setState("error")} testID="file-preview-image" />
            {state === "loading" && src ? <ActivityIndicator color="#FFFFFF" size="large" style={{ position: "absolute" }} /> : null}
            {state === "error" ? (
              <View style={{ position: "absolute", alignItems: "center", gap: space.md, padding: space.xl }}>
                <Text style={{ color: "#FFFFFF", fontSize: 16, textAlign: "center" }}>This image couldn't load here.</Text>
                <Button label="Open in another app" variant="secondary" onPress={() => void share()} />
              </View>
            ) : null}
          </>
        )}
      </View>
      <View style={{ height: insets.bottom + space.md }} />
    </View>
  );
}
