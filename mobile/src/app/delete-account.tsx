import { useState } from "react";
import { Alert, Platform, ScrollView, Text } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { Button, Card, Field } from "@/components/ui";
import { useSession } from "@/lib/session";
import { LINKS } from "@/config";
import { colors, font, space } from "@/theme";

/** In-app account deletion, which the App Store and Google Play both require. */
export default function DeleteAccount() {
  const { deleteAccount, mode, me } = useSession();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setError(null);
    if (mode === "live" && !password) return setError("Enter your password to confirm.");
    setBusy(true);
    try { await deleteAccount(password); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const confirm = () => {
    if (Platform.OS === "web") return run();
    Alert.alert("Delete your account for good?", "This can't be undone.", [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: run }]);
  };

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled">
      <Card style={{ gap: space.sm, borderColor: "rgba(251,113,133,0.35)" }}>
        <Text style={[font.heading, { fontSize: 18 }]}>What gets deleted</Text>
        <Text style={font.small}>Your login, and every workspace where you're the only member, including its mailboxes, mail, agents and tasks. Paid add-ons are cancelled.</Text>
        <Text style={font.small}>If you own a workspace other people use, hand it to someone else on the web first.</Text>
        <Text style={font.small}>Backups that still hold your data expire within 30 days. We email {me?.user.email ?? "you"} to confirm.</Text>
      </Card>
      {mode === "live" ? (
        <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" testID="delete-password" />
      ) : <Text style={font.small}>You're in the sample workspace, so this only clears it from this phone.</Text>}
      {error ? <Text style={{ color: colors.bad }} accessibilityRole="alert">{error}</Text> : null}
      <Button variant="danger" icon="user-x" label="Delete my account" onPress={confirm} loading={busy} testID="confirm-delete" />
      <Button variant="ghost" label="Signed in with Google or Auth0? Delete on the web" onPress={() => WebBrowser.openBrowserAsync(LINKS.accountSettings)} />
    </ScrollView>
  );
}
