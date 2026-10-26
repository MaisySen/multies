import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button, Banner } from "@/components/ui";
import { Logo } from "@/components/logo";
import { useSession } from "@/lib/session";
import { IdpError } from "@/lib/idp";
import { LINKS, SAMPLE_ONLY } from "@/config";
import { colors, font, space } from "@/theme";

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
      <ScrollView contentContainerStyle={{ padding: space.xl, gap: space.lg, flexGrow: 1, justifyContent: "center", maxWidth: 480, width: "100%", alignSelf: "center" }}>
        <View style={{ alignItems: "flex-start", gap: space.md, marginBottom: space.md }}>
          <Logo size={52} />
          <Text style={font.title} accessibilityRole="header">Sign in to Multies</Text>
          <Text style={font.small}>Your inbox, your team and your AI agents, in your pocket.</Text>
        </View>

        {SAMPLE_ONLY ? (
          <Banner tone="brand" icon="info" text="This browser preview runs on sample data. Sign in with your Multies account in the iPhone or Android app." />
        ) : null}

        {error ? <Text style={{ color: colors.bad, fontSize: 14 }} accessibilityLiveRegion="assertive" accessibilityRole="alert">{error}</Text> : null}

        <Button label="Continue with Multies" onPress={() => go("signin")} loading={busy === "signin"} disabled={SAMPLE_ONLY || busy !== null} testID="sign-in"
          accessibilityHint="Opens the Multies sign in page" />
        <Button label="Create account" variant="secondary" onPress={() => go("signup")} loading={busy === "signup"} disabled={SAMPLE_ONLY || busy !== null} testID="sign-up" />
        <Button label="Explore with sample data" variant="ghost" icon="compass" onPress={() => startSample()} testID="sample"
          accessibilityHint="Opens a made up workspace that lives only on this device" />

        <Text style={[font.small, { textAlign: "center", marginTop: space.sm }]}>
          Use your email, a one time code, a passkey, or your Google, Apple or GitHub account.
        </Text>
        {/* R35 (Apple 1.2): people agree to the terms, which have no tolerance for objectionable content or abusive users. */}
        <Text style={[font.small, { textAlign: "center" }]} testID="agree-line">
          By continuing you agree to the{" "}
          <Text style={{ color: colors.brand }} accessibilityRole="link" onPress={() => WebBrowser.openBrowserAsync(LINKS.terms)}>Terms</Text>
          {" "}and the{" "}
          <Text style={{ color: colors.brand }} accessibilityRole="link" onPress={() => WebBrowser.openBrowserAsync(LINKS.acceptableUse)}>Acceptable use policy</Text>
          , including no tolerance for objectionable content or abusive users.
        </Text>
        <Button variant="ghost" label="Help signing in" onPress={() => WebBrowser.openBrowserAsync(LINKS.support)} />
      </ScrollView>
    </SafeAreaView>
  );
}
