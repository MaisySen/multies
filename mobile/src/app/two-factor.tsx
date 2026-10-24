import { useState } from "react";
import { ScrollView, Switch, Text, View } from "react-native";
import { router } from "expo-router";
import { Button, Field } from "@/components/ui";
import { useSession } from "@/lib/session";
import { colors, font, space } from "@/theme";

export default function TwoFactor() {
  const { verifyTwoFactor } = useSession();
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState(false);
  const [trust, setTrust] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (!backup && code.replace(/\D/g, "").length !== 6) return setError("Enter the 6 digit code from your authenticator app.");
    if (backup && code.trim().length < 6) return setError("Enter one of your backup codes.");
    setBusy(true);
    try { await verifyTwoFactor(code, { backup, trustDevice: trust }); }
    catch (e) {
      const err = e as { code?: string; message: string };
      if (err.code === "invalid_two_factor_cookie") { setError(err.message); setTimeout(() => router.back(), 1500); }
      else setError(err.message);
    } finally { setBusy(false); }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: space.xl, gap: space.lg, maxWidth: 480, width: "100%", alignSelf: "center" }} keyboardShouldPersistTaps="handled">
      <Text style={font.small}>
        {backup ? "Enter one of the backup codes you saved when you turned on two step sign in. Each code works once." : "Open your authenticator app and enter the 6 digit code for Multies."}
      </Text>
      <Field label={backup ? "Backup code" : "Code"} testID="code" value={code} onChangeText={setCode} autoFocus
        keyboardType={backup ? "default" : "number-pad"} autoComplete="one-time-code" textContentType="oneTimeCode" autoCapitalize="none"
        maxLength={backup ? 32 : 7} onSubmitEditing={submit} style={{ fontSize: 22, letterSpacing: backup ? 1 : 6 }} />
      {!backup ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md }}>
          <Text style={{ color: colors.fg, fontSize: 16, flex: 1 }} nativeID="trust-label">Trust this phone for 30 days</Text>
          <Switch value={trust} onValueChange={setTrust} accessibilityLabelledBy="trust-label" accessibilityLabel="Trust this phone for 30 days"
            trackColor={{ true: colors.brand, false: colors.elevated }} thumbColor={colors.fg} />
        </View>
      ) : null}
      {error ? <Text style={{ color: colors.bad, fontSize: 14 }} accessibilityRole="alert">{error}</Text> : null}
      <Button label="Verify" onPress={submit} loading={busy} testID="verify" />
      <Button variant="ghost" label={backup ? "Use my authenticator app" : "Use a backup code"} onPress={() => { setBackup(!backup); setCode(""); setError(null); }} />
    </ScrollView>
  );
}
