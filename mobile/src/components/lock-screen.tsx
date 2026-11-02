import { useEffect, useRef, useState } from "react";
import { Alert, Animated, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "./ui";
import { Logo } from "./logo";
import { BarBlur, hasBarBlur } from "./chrome";
import { haptic, tick } from "@/lib/haptics";
import { authenticate, biometricLabel, checkPin, clearLock, lockWait, pinLength, PIN_MAX, type LockSettings } from "@/lib/app-lock";
import { useSession } from "@/lib/session";
import { colors, font, radius, space } from "@/theme";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "bio", "0", "del"] as const;

/** M4: the number pad and the PIN dots, shared by the lock screen and PIN setup. */
export function PinPad({ length, value, onChange, onBiometric, biometricName, error, title, subtitle, disabled, testID = "pin-pad" }: {
  length: number; value: string; onChange: (v: string) => void; onBiometric?: () => void; biometricName?: string;
  error?: string | null; title: string; subtitle?: string | null; disabled?: boolean; testID?: string;
}) {
  const [shake] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!error) return;
    haptic("warning");
    Animated.sequence([10, -10, 8, -8, 4, 0].map((x) => Animated.timing(shake, { toValue: x, duration: 50, useNativeDriver: Platform.OS !== "web" }))).start();
  }, [error, shake]);
  const press = (k: (typeof KEYS)[number]) => {
    if (disabled) return;
    if (k === "bio") { onBiometric?.(); return; }
    tick();
    if (k === "del") onChange(value.slice(0, -1));
    else if (value.length < length) onChange(value + k);
  };
  return (
    <View style={s.pad} testID={testID}>
      <Text style={[font.heading, { textAlign: "center" }]} accessibilityRole="header">{title}</Text>
      {subtitle ? <Text style={[font.small, { textAlign: "center" }]}>{subtitle}</Text> : null}
      <Animated.View style={[s.dots, { transform: [{ translateX: shake }] }]} accessible accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: length, now: value.length }} accessibilityLabel={`${value.length} of ${length} digits entered`}>
        {Array.from({ length }, (_, i) => <View key={i} style={[s.dot, i < value.length && s.dotOn]} />)}
      </Animated.View>
      <Text style={[s.error, { opacity: error ? 1 : 0 }]} accessibilityLiveRegion="polite" testID={`${testID}-error`}>{error ?? " "}</Text>
      <View style={s.keys}>
        {KEYS.map((k) => {
          if (k === "bio" && !onBiometric) return <View key={k} style={s.key} />;
          const label = k === "del" ? "Delete" : k === "bio" ? `Use ${biometricName ?? "Face ID"}` : k;
          return (
            <Pressable key={k} onPress={() => press(k)} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} testID={`${testID}-${k}`}
              style={({ pressed }) => [s.key, k !== "bio" && k !== "del" && s.digit, pressed && { backgroundColor: colors.elevated, transform: [{ scale: 0.94 }] }, disabled && { opacity: 0.4 }]}>
              {k === "del" ? <Icon name="back" size={24} color={colors.fg} /> : k === "bio" ? <Icon name="lock" size={24} color={colors.brand} /> : <Text style={s.digitText}>{k}</Text>}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** M4: covers the app until Face ID, the fingerprint or the PIN passes. Forgot PIN signs out. */
export function LockScreen({ onUnlock, settings }: { onUnlock: () => void; settings: LockSettings | null }) {
  const insets = useSafeAreaInsets();
  const { signOut } = useSession();
  const [pin, setPin] = useState("");
  const [len, setLen] = useState(4);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const [bioName, setBioName] = useState("Face ID");
  const busy = useRef(false);
  const bio = !!settings?.biometric;
  const hasPin = settings?.hasPin ?? true;

  const tryBiometric = async () => {
    if (busy.current) return;
    busy.current = true;
    const ok = await authenticate("Unlock Multies");
    busy.current = false;
    if (ok) { haptic("success"); onUnlock(); }
  };
  useEffect(() => {
    pinLength().then(setLen).catch(() => {});
    biometricLabel().then(setBioName).catch(() => {});
    lockWait().then(setWait).catch(() => {});
    if (bio) tryBiometric();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => Math.max(0, w - 1)), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const forgot = () => {
    const go = async () => { await clearLock(); await signOut(); };
    if (Platform.OS === "web") { go(); return; }
    Alert.alert("Forgot your PIN?", "Sign out, then sign back in to use Multies again. You can set a new PIN after.", [
      { text: "Cancel", style: "cancel" }, { text: "Sign out", style: "destructive", onPress: () => { go(); } },
    ]);
  };
  const onChange = async (v: string) => {
    setPin(v); setError(null);
    if (v.length < len) return;
    const r = await checkPin(v);
    setPin("");
    if (r.ok) { haptic("success"); onUnlock(); return; }
    if (r.signOut) { await clearLock(); await signOut(); return; }
    setWait(r.waitSeconds);
    setError(r.waitSeconds ? `Too many tries. Wait ${r.waitSeconds} seconds.` : r.left <= 3 ? `Wrong PIN. ${r.left} tries left before sign out.` : "Wrong PIN. Try again.");
  };

  return (
    <View style={[StyleSheet.absoluteFill, s.screen, { paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.lg }]} testID="lock-screen" accessibilityViewIsModal>
      <View style={{ alignItems: "center", gap: space.sm }}>
        <Logo size={56} />
        <Text style={[font.small, { textAlign: "center" }]}>Multies is locked</Text>
      </View>
      {hasPin ? (
        <PinPad length={len} value={pin} onChange={onChange} onBiometric={bio ? tryBiometric : undefined} biometricName={bioName}
          error={wait ? `Too many tries. Wait ${wait} seconds.` : error} title="Enter your PIN" disabled={wait > 0} testID="lock-pin" />
      ) : (
        <Pressable onPress={tryBiometric} style={s.bioButton} accessibilityRole="button" testID="lock-biometric">
          <Icon name="lock" size={22} color={colors.brandFg} />
          <Text style={{ color: colors.brandFg, fontSize: 17, fontWeight: "600" }}>Unlock with {bioName}</Text>
        </Pressable>
      )}
      <Pressable onPress={forgot} accessibilityRole="button" testID="lock-forgot" hitSlop={12}>
        <Text style={{ color: colors.brand, fontSize: 15, fontWeight: "600", textAlign: "center" }}>{hasPin ? "Forgot PIN?" : "Sign out"}</Text>
      </Pressable>
    </View>
  );
}

/** M4: what the app switcher shows while the lock is on and "Hide content" is set. */
export function PrivacyCover() {
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: hasBarBlur() ? "transparent" : colors.bg, alignItems: "center", justifyContent: "center" }]} testID="privacy-cover" pointerEvents="none">
      {hasBarBlur() ? <View style={StyleSheet.absoluteFill}><BarBlur /></View> : null}
      <Logo size={72} />
    </View>
  );
}

const s = StyleSheet.create({
  screen: { backgroundColor: colors.bg, alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.xl },
  pad: { alignItems: "center", gap: space.sm, width: "100%", maxWidth: 320 },
  dots: { flexDirection: "row", gap: 16, marginTop: space.lg, minHeight: 16 },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, borderColor: colors.muted },
  dotOn: { backgroundColor: colors.fg, borderColor: colors.fg },
  error: { color: colors.bad, fontSize: 14, textAlign: "center", minHeight: 20 },
  keys: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 14, width: "100%", marginTop: space.sm },
  key: { width: 78, height: 78, borderRadius: 39, alignItems: "center", justifyContent: "center", marginHorizontal: 6 },
  digit: { backgroundColor: colors.neutralSoft },
  digitText: { fontSize: 32, fontWeight: "400", color: colors.fg, fontVariant: ["tabular-nums"] },
  bioButton: { flexDirection: "row", alignItems: "center", gap: space.sm, backgroundColor: colors.brandFill, paddingHorizontal: space.xl, minHeight: 52, borderRadius: radius.pill },
});

export { PIN_MAX };
