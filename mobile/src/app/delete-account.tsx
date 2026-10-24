import { useState } from "react";
import { Alert, Platform, ScrollView, Text } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { Button, Card, Field } from "@/components/ui";
import { useSession } from "@/lib/session";
import { CONFIRM_WORD, confirmTyped, deleteAccountMessage } from "@/lib/delete-account";
import { LINKS } from "@/config";
import { colors, font, space } from "@/theme";

/** In-app account deletion, which the App Store and Google Play both require. */
export default function DeleteAccount() {
  const { deleteAccount, mode, me } = useSession();
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const openWeb = () => WebBrowser.openBrowserAsync(LINKS.deleteAccount);

  if (mode === "sample") {
    const leave = async () => { setBusy(true); try { await deleteAccount(); } finally { setBusy(false); } };
    return (
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
        <Card style={{ gap: space.sm }}>
          <Text style={[font.heading, { fontSize: 18 }]}>There{"'"}s no account to delete</Text>
          <Text style={font.small} testID="sample-delete-note">You{"'"}re exploring sample data. Nothing about you is stored on MyMail{"'"}s servers, so there is no account here to delete.</Text>
          <Text style={font.small}>With a real account, this screen deletes your login and the workspaces only you use, straight from the app.</Text>
        </Card>
        <Button variant="ghost" icon="log-out" label="Leave the sample workspace" onPress={leave} loading={busy} testID="leave-sample" />
        <Button variant="ghost" icon="external-link" label="Delete account on the web" onPress={openWeb} testID="delete-on-web" />
      </ScrollView>
    );
  }

  const ready = confirmTyped(typed);
  const run = async () => {
    setError(null);
    setBusy(true);
    try { await deleteAccount(password); }
    catch (e) { setError(deleteAccountMessage(e)); }
    finally { setBusy(false); }
  };
  const confirm = () => {
    if (!ready) return setError(`Type ${CONFIRM_WORD} in capitals to confirm.`);
    if (Platform.OS === "web") return run();
    Alert.alert("Delete your account for good?", "This can't be undone.", [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: run }]);
  };

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled">
      <Card style={{ gap: space.sm, borderColor: "rgba(251,113,133,0.35)" }}>
        <Text style={[font.heading, { fontSize: 18 }]}>What gets deleted</Text>
        <Text style={font.small}>Your login{me?.user.email ? ` (${me.user.email})` : ""}, your sessions and this phone{"'"}s notifications.</Text>
        <Text style={font.small}>Every workspace where you{"'"}re the only member, with all of its mailboxes, mail, agents, tasks, projects, docs, contacts, time entries and meetings.</Text>
        <Text style={font.small}>If you own a workspace that other people use, make someone else an owner on the web first.</Text>
        <Text style={font.small}>This can{"'"}t be undone. Copies in backups expire within 30 days.</Text>
      </Card>
      <Field label={`Type ${CONFIRM_WORD} to confirm`} value={typed} onChangeText={setTyped} autoCapitalize="characters" autoCorrect={false} testID="delete-confirm-word" />
      <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" testID="delete-password" />
      <Text style={font.tiny}>Signed up with Google? Leave the password empty.</Text>
      {error ? <Text style={{ color: colors.bad }} accessibilityRole="alert" testID="delete-error">{error}</Text> : null}
      <Button variant="danger" icon="user-x" label="Delete my account" onPress={confirm} loading={busy} disabled={!ready} testID="confirm-delete" />
      <Button variant="ghost" icon="external-link" label="Delete account on the web" onPress={openWeb} testID="delete-on-web" />
    </ScrollView>
  );
}
