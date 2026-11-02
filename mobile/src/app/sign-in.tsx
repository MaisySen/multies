import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button, Banner, Icon, TILE } from "@/components/ui";
import { Logo } from "@/components/logo";
import { useSession } from "@/lib/session";
import { IdpError } from "@/lib/idp";
import { LINKS, SAMPLE_ONLY } from "@/config";
import { colors, font, shadow, space } from "@/theme";
import { openInApp } from "@/lib/web-open";

/**
 * Sign in and sign up happen on the Multies sign in page in the system browser (email and
 * password, a one time code, a passkey or a social account, plus two step verification),
 * then the app holds only its Multies session, in the device's secure storage.
 */
export default function SignIn() {
  const { signInWithIdp, startSample } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"signin" | "signup" | null>(null);

  const go = async (mode: "signin" | "signup") => {
    setError(null);
    setBusy(mode);
    try {
      await signInWithIdp(mode);
    } catch (e) {
      if (!(e instanceof IdpError && e.code === "cancelled")) setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.xl, paddingTop: space.xl, paddingBottom: space.lg, gap: space.lg, flexGrow: 1, maxWidth: 480, width: "100%", alignSelf: "center" }}>
        {/* R36: a calm hero, then the actions in one group at the bottom with the agree line right above them. */}
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center", gap: space.md, paddingVertical: space.xl }}>
          <View style={{ width: 112, height: 112, borderRadius: 56, alignItems: "center", justifyContent: "center", backgroundColor: colors.brandSoft }}>
            <View style={{ width: 84, height: 84, borderRadius: 24, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface, ...shadow,
              shadowOpacity: 0.12, shadowRadius: 16, shadowOffset: { width: 0, height: 6 } }}>
              <Logo size={56} />
            </View>
          </View>
          <Text style={[font.largeTitle, { textAlign: "center", marginTop: space.sm }]} accessibilityRole="header">Sign in to Multies</Text>
          <Text style={[font.body, { color: colors.muted, textAlign: "center", maxWidth: 320 }]}>Your inbox, your team and your AI agents, in your pocket.</Text>
          <View style={{ flexDirection: "row", gap: space.lg, marginTop: space.md }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {([["mail", "blue", "Mail"], ["check-square", "orange", "Tasks"], ["chat", "green", "Chat"], ["bot", "purple", "Agents"]] as const).map(([icon, tile, label]) => (
              <View key={label} style={{ alignItems: "center", gap: 6 }}>
                <View style={{ width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: TILE[tile] }}><Icon name={icon} size={22} color="#FFFFFF" filled /></View>
                <Text style={{ color: colors.muted, fontSize: 12, fontWeight: "500" }}>{label}</Text>
              </View>
            ))}
          </View>
        </View>

        {SAMPLE_ONLY ? (
          <Banner tone="brand" icon="info" text="This browser preview runs on sample data. Sign in with your Multies account in the iPhone or Android app." />
        ) : null}

        {error ? <Text style={{ color: colors.bad, fontSize: 14, textAlign: "center" }} accessibilityLiveRegion="assertive" accessibilityRole="alert">{error}</Text> : null}

        <View style={{ gap: space.md }}>
          {/* R35 (Apple 1.2): people agree to the terms, which have no tolerance for objectionable content or abusive users. Kept above the buttons. */}
          <Text style={[font.small, { textAlign: "center", fontSize: 13, lineHeight: 18 }]} testID="agree-line">
            By continuing you agree to the{" "}
            <Text style={{ color: colors.brand, fontWeight: "600" }} accessibilityRole="link" onPress={() => openInApp(LINKS.terms)} testID="terms-link">Terms</Text>
            {" "}and the{" "}
            <Text style={{ color: colors.brand, fontWeight: "600" }} accessibilityRole="link" onPress={() => openInApp(LINKS.acceptableUse)} testID="aup-link">Acceptable use policy</Text>
            , including no tolerance for objectionable content or abusive users.
          </Text>
          <Button label="Continue with Multies" onPress={() => go("signin")} loading={busy === "signin"} disabled={SAMPLE_ONLY || busy !== null} testID="sign-in"
            accessibilityHint="Opens the Multies sign in page" style={{ minHeight: 52, borderRadius: 14 }} />
          <Button label="Create account" variant="secondary" onPress={() => go("signup")} loading={busy === "signup"} disabled={SAMPLE_ONLY || busy !== null} testID="sign-up"
            style={{ minHeight: 52, borderRadius: 14 }} />
          <Button label="Explore with sample data" variant="ghost" icon="compass" onPress={() => startSample()} testID="sample"
            accessibilityHint="Opens a made up workspace that lives only on this device" />
          <Text style={[font.tiny, { textAlign: "center", lineHeight: 17 }]}>
            Use your email, a one time code, a passkey, or your Google, Apple or GitHub account.
          </Text>
          <Button variant="ghost" label="Help signing in" icon="life-buoy" onPress={() => openInApp(LINKS.support)} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
