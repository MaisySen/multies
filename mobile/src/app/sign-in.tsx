import { useRef, useState, type ComponentRef } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button, Field, Banner } from "@/components/ui";
import { Logo } from "@/components/logo";
import { useSession } from "@/lib/session";
import { EMAIL_RE } from "@/lib/format";
import { LINKS, SAMPLE_ONLY } from "@/config";
import { colors, font, space } from "@/theme";

export default function SignIn() {
  const { signIn, startSample } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pw = useRef<ComponentRef<typeof TextInput>>(null);

  const submit = async () => {
    setError(null);
    if (!EMAIL_RE.test(email.trim())) return setError("Enter the email you use for MyMail.");
    if (!password) return setError("Enter your password.");
    setBusy(true);
    try {
      const r = await signIn(email, password);
      if (r === "twoFactor") router.push("/two-factor");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: space.xl, gap: space.lg, flexGrow: 1, justifyContent: "center", maxWidth: 480, width: "100%", alignSelf: "center" }} keyboardShouldPersistTaps="handled">
          <View style={{ alignItems: "flex-start", gap: space.md, marginBottom: space.md }}>
            <Logo size={52} />
            <Text style={font.title} accessibilityRole="header">Sign in to MyMail</Text>
            <Text style={font.small}>Your inbox, your team and your AI agents, in your pocket.</Text>
          </View>

          {SAMPLE_ONLY ? (
            <Banner tone="brand" icon="info" text="This browser preview runs on sample data. Sign in with your MyMail account in the iPhone or Android app." />
          ) : null}

          <Field label="Email" testID="email" value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address"
            textContentType="username" returnKeyType="next" onSubmitEditing={() => pw.current?.focus()} placeholder="you@yourbusiness.com.au" editable={!SAMPLE_ONLY} />
          <Field ref={pw} label="Password" testID="password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password"
            textContentType="password" returnKeyType="go" onSubmitEditing={submit} editable={!SAMPLE_ONLY} />
          {error ? <Text style={{ color: colors.bad, fontSize: 14 }} accessibilityLiveRegion="assertive" accessibilityRole="alert">{error}</Text> : null}

          <Button label="Sign in" onPress={submit} loading={busy} disabled={SAMPLE_ONLY} testID="sign-in" />
          <Button label="Explore with sample data" variant="secondary" icon="compass" onPress={() => startSample()} testID="sample"
            accessibilityHint="Opens a made up workspace that lives only on this device" />

          <View style={{ flexDirection: "row", justifyContent: "space-between", flexWrap: "wrap", gap: space.sm, marginTop: space.sm }}>
            <Button variant="ghost" label="Forgot password?" onPress={() => WebBrowser.openBrowserAsync(LINKS.forgotPassword)} />
            <Button variant="ghost" label="Create a free account" onPress={() => WebBrowser.openBrowserAsync(LINKS.signup)} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
