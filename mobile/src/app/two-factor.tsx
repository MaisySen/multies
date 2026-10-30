import { useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { Button, Icon, TILE } from "@/components/ui";
import { GroupRow, InsetGroup } from "@/components/grouped";
import { tick, warning } from "@/lib/haptics";
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
      warning();
      const err = e as { code?: string; message: string };
      if (err.code === "invalid_two_factor_cookie") { setError(err.message); setTimeout(() => router.back(), 1500); }
      else setError(err.message);
    } finally { setBusy(false); }
  };

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ paddingVertical: space.xl, maxWidth: 480, width: "100%", alignSelf: "center" }} keyboardShouldPersistTaps="handled">
      {/* R36: the same hero and inset group as sign in and Settings. */}
      <View style={{ alignItems: "center", gap: space.sm, paddingHorizontal: space.xl, marginBottom: space.sm }}>
        <View style={{ width: 64, height: 64, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: TILE.green }}>
          <Icon name={backup ? "key" : "shield"} size={32} color="#FFFFFF" filled />
        </View>
        <Text style={[font.title, { textAlign: "center" }]} accessibilityRole="header">{backup ? "Use a backup code" : "Two step sign in"}</Text>
        <Text style={[font.small, { textAlign: "center" }]}>
          {backup ? "Enter one of the backup codes you saved when you turned on two step sign in. Each code works once." : "Open your authenticator app and enter the 6 digit code for Multies."}
        </Text>
      </View>
      <InsetGroup footer={!backup ? "Trusted phones skip the code for 30 days. You can remove them on the web under Security." : undefined}>
        <View style={{ padding: space.lg }}>
          <TextInput testID="code" value={code} onChangeText={setCode} autoFocus accessibilityLabel={backup ? "Backup code" : "Code"}
            keyboardType={backup ? "default" : "number-pad"} autoComplete="one-time-code" textContentType="oneTimeCode" autoCapitalize="none"
            maxLength={backup ? 32 : 7} onSubmitEditing={submit} placeholder={backup ? "Backup code" : "000000"} placeholderTextColor={colors.subtle} selectionColor={colors.brand}
            style={{ color: colors.fg, fontSize: 28, fontWeight: "600", letterSpacing: backup ? 1 : 10, textAlign: "center", fontVariant: ["tabular-nums"], paddingVertical: space.sm }} />
        </View>
        {!backup ? <GroupRow icon="smartphone" tile="blue" label="Trust this phone for 30 days" toggle={{ value: trust, onChange: setTrust }} testID="trust" /> : null}
      </InsetGroup>
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.lg, gap: space.md }}>
        {error ? <Text style={{ color: colors.bad, fontSize: 14, textAlign: "center" }} accessibilityRole="alert">{error}</Text> : null}
        <Button label="Verify" onPress={submit} loading={busy} testID="verify" style={{ minHeight: 52, borderRadius: 14 }} />
        <Button variant="ghost" label={backup ? "Use my authenticator app" : "Use a backup code"} onPress={() => { tick(); setBackup(!backup); setCode(""); setError(null); }} />
      </View>
    </ScrollView>
  );
}
