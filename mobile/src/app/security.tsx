/**
 * M4: Settings > Security > Lock Multies. Face ID, Touch ID or the fingerprint with a 4 to 6 digit PIN
 * fallback, lock on open or after 1, 5 or 15 minutes away, hide content in the app switcher.
 */
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScreenHeader } from "@/components/m3-ui";
import { GroupRow, InsetGroup } from "@/components/grouped";
import { PinPad } from "@/components/lock-screen";
import { Button, Icon } from "@/components/ui";
import { TintIcon } from "@/components/m4-ui";
import { haptic } from "@/lib/haptics";
import {
  AFTER_OPTIONS, authenticate, biometricAvailable, biometricLabel, checkPin, getLockSettings, saveLockSetting, setPin, turnOffLock, turnOnLock, pinLength, type LockSettings,
} from "@/lib/app-lock";
import { colors, font, space } from "@/theme";

type Step = null | { kind: "create"; first?: string } | { kind: "verify"; then: "off" | "change" };

export default function Security() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ setup?: string }>();
  const [s, setS] = useState<LockSettings | null>(null);
  const [bioOk, setBioOk] = useState(false);
  const [bioName, setBioName] = useState("Face ID");
  const [step, setStep] = useState<Step>(params.setup === "1" ? { kind: "create" } : null);
  const [len, setLen] = useState(4);
  const [pin, setPinValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const load = () => getLockSettings().then(setS).catch(() => {});
  useEffect(() => {
    load();
    biometricAvailable().then(setBioOk).catch(() => {});
    biometricLabel().then(setBioName).catch(() => {});
  }, []);

  const startVerify = async (then: "off" | "change") => {
    setLen(await pinLength().catch(() => 4));
    if (s?.biometric && (await authenticate(then === "off" ? "Turn off the lock" : "Change your PIN"))) { finishVerify(then); return; }
    if (!s?.hasPin) { if (then === "off") { await turnOffLock(); await load(); } return; }
    setPinValue(""); setError(null); setStep({ kind: "verify", then });
  };
  const finishVerify = async (then: "off" | "change") => {
    if (then === "off") { await turnOffLock(); haptic("success"); setStep(null); setDone("Lock is off."); await load(); return; }
    setLen(4); setPinValue(""); setError(null); setStep({ kind: "create" });
  };
  const onPin = async (v: string) => {
    setPinValue(v); setError(null);
    if (!step || v.length < len) return;
    if (step.kind === "verify") {
      const r = await checkPin(v);
      setPinValue("");
      if (r.ok) finishVerify(step.then);
      else setError(r.waitSeconds ? `Too many tries. Wait ${r.waitSeconds} seconds.` : "Wrong PIN. Try again.");
      return;
    }
    if (!step.first) { setStep({ kind: "create", first: v }); setPinValue(""); return; }
    setPinValue("");
    if (v !== step.first) { setStep({ kind: "create" }); setError("Those PINs did not match. Start again."); return; }
    if (s?.on) { await setPin(v); setDone("PIN changed."); }
    else { const r = await turnOnLock(v, bioOk); setDone(r.biometric ? `Lock is on. ${bioName} or your PIN opens Multies.` : "Lock is on. Your PIN opens Multies."); }
    haptic("success"); setStep(null); await load();
  };

  const header = <ScreenHeader title="Lock Multies" testID="security-header" />;
  if (step) {
    const title = step.kind === "verify" ? "Enter your PIN" : step.first ? "Enter it again" : "Create a PIN";
    const sub = step.kind === "create" && !step.first ? `${len} digits. You'll use it when ${bioOk ? bioName : "Face ID"} can't.` : null;
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }} testID="security-pin">
        {header}
        <View style={{ flex: 1, alignItems: "center", paddingTop: space.xl, paddingHorizontal: space.xl, gap: space.lg }}>
          <PinPad length={len} value={pin} onChange={onPin} title={title} subtitle={sub} error={error} testID="setup-pin" />
          {step.kind === "create" && !step.first ? (
            <Pressable onPress={() => { setLen(len === 4 ? 6 : 4); setPinValue(""); }} accessibilityRole="button" testID="pin-length" hitSlop={10}>
              <Text style={{ color: colors.brand, fontSize: 15, fontWeight: "600" }}>{len === 4 ? "Use 6 digits" : "Use 4 digits"}</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={() => { setStep(null); setError(null); }} accessibilityRole="button" testID="pin-cancel" hitSlop={10}>
            <Text style={{ color: colors.muted, fontSize: 15 }}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="security-screen">
      {header}
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + space.xxl }}>
        <View style={{ alignItems: "center", gap: space.sm, paddingHorizontal: space.xl, paddingTop: space.lg }}>
          <TintIcon icon="lock" color={s?.on ? colors.ok : colors.brand} size={64} />
          <Text style={[font.heading, { textAlign: "center" }]}>{s?.on ? "Multies is locked when you leave" : "Keep your mail and tasks private"}</Text>
          <Text style={[font.small, { textAlign: "center" }]}>{bioOk ? `${bioName} opens the app. Your PIN works when ${bioName} can't.` : "A PIN opens the app."}</Text>
          {done ? <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }} testID="security-done"><Icon name="check-circle" size={16} color={colors.ok} filled /><Text style={{ color: colors.ok, fontSize: 15 }}>{done}</Text></View> : null}
        </View>
        {!s?.on ? (
          <View style={{ padding: space.lg }}>
            <Button label="Turn on lock" icon="lock" onPress={() => { setLen(4); setPinValue(""); setError(null); setStep({ kind: "create" }); }} testID="lock-turn-on" />
          </View>
        ) : (
          <>
            <InsetGroup footer="Forgot your PIN? Sign out and sign back in, then set a new one.">
              <GroupRow label="Lock Multies" icon="lock" tile="green" toggle={{ value: true, onChange: () => { startVerify("off"); } }} testID="lock-on" />
              {bioOk ? <GroupRow label={`Unlock with ${bioName}`} icon="user-check" tile="blue" testID="lock-bio"
                toggle={{ value: !!s.biometric, onChange: async (v) => { if (v && !(await authenticate(`Use ${bioName} for Multies`))) return; await saveLockSetting("biometric", v); load(); } }} /> : null}
              {s.hasPin ? <GroupRow label="Change PIN" icon="key" tile="gray" onPress={() => startVerify("change")} testID="lock-change" /> : null}
            </InsetGroup>
            <InsetGroup header="Require unlock">
              {AFTER_OPTIONS.map((o) => (
                <GroupRow key={o.id} label={o.id === "0" ? "Every time I open it" : o.label} testID={`lock-after-${o.id}`}
                  onPress={async () => { await saveLockSetting("after", o.id); load(); }} chevron={false}
                  right={s.after === o.id ? <Icon name="check" size={18} color={colors.brand} /> : null} />
              ))}
            </InsetGroup>
            <InsetGroup footer="The app switcher shows the Multies logo instead of your mail.">
              <GroupRow label="Hide content in the app switcher" icon="eye" tile="purple" testID="lock-hide"
                toggle={{ value: s.hide, onChange: async (v) => { await saveLockSetting("hide", v); load(); } }} />
            </InsetGroup>
          </>
        )}
      </ScrollView>
    </View>
  );
}
