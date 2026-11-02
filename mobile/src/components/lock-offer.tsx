import { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "./ui";
import { TintIcon } from "./m4-ui";
import { biometricAvailable, biometricLabel, markLockOffered, shouldOfferLock } from "@/lib/app-lock";
import { colors, font, radius, raised, space } from "@/theme";

/** M4: one friendly offer after sign in to lock the app. Shown once; "Not now" never asks again. */
export function LockOffer({ onDone }: { onDone?: () => void }) {
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      if (!(await shouldOfferLock().catch(() => false)) || !live) return;
      if (await biometricAvailable().catch(() => false)) setName(await biometricLabel().catch(() => "Face ID"));
      if (live) setOpen(true);
    }, 2500);
    return () => { live = false; clearTimeout(t); };
  }, []);
  const close = async (setup: boolean) => {
    setOpen(false);
    await markLockOffered().catch(() => {});
    onDone?.();
    if (setup) router.push("/security?setup=1" as never);
  };
  if (!open) return null;
  return (
    <Modal transparent animationType="slide" visible onRequestClose={() => close(false)}>
      <Pressable style={s.scrim} onPress={() => close(false)} accessibilityLabel="Not now" />
      <View style={[s.sheet, { paddingBottom: insets.bottom + space.lg }]} testID="lock-offer">
        <View style={s.grab} />
        <TintIcon icon="lock" color={colors.brand} size={56} />
        <Text style={[font.heading, { textAlign: "center" }]}>Keep Multies private</Text>
        <Text style={[font.small, { textAlign: "center" }]}>
          {name ? `Lock the app with ${name} and a PIN, so only you can open your mail and tasks.` : "Lock the app with a PIN, so only you can open your mail and tasks."}
        </Text>
        <Button label="Set up lock" onPress={() => close(true)} style={{ alignSelf: "stretch", marginTop: space.sm }} testID="lock-offer-yes" />
        <Button label="Not now" variant="ghost" onPress={() => close(false)} style={{ alignSelf: "stretch" }} testID="lock-offer-no" />
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  scrim: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.35)" },
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: colors.surface, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: space.xl, gap: space.md, alignItems: "center", ...raised },
  grab: { width: 36, height: 5, borderRadius: 3, backgroundColor: colors.lineStrong, marginBottom: space.sm },
});
