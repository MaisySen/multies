import { useState } from "react";
import { Alert, Platform, ScrollView, Text, View } from "react-native";
import { GroupRow, InsetGroup } from "@/components/grouped";
import { warning } from "@/lib/haptics";
import { Button, Card, Field } from "@/components/ui";
import { useSession } from "@/lib/session";
import { CONFIRM_WORD, confirmTyped, deleteAccountMessage } from "@/lib/delete-account";
import { LINKS } from "@/config";
import { colors, font, space } from "@/theme";
import { openInApp } from "@/lib/web-open";

/** In-app account deletion, which the App Store and Google Play both require. */
export default function DeleteAccount() {
  const { deleteAccount, mode, me } = useSession();
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const openOnWeb = () => openInApp(LINKS.deleteAccount);

  if (mode === "sample") {
    const leave = async () => { setBusy(true); try { await deleteAccount(); } finally { setBusy(false); } };
    return (
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
        <Card style={{ gap: space.sm }}>
          <Text style={[font.heading, { fontSize: 18 }]}>There{"'"}s no account to delete</Text>
          <Text style={font.small} testID="sample-delete-note">You{"'"}re exploring sample data. Nothing about you is stored on Multies{"'"}s servers, so there is no account here to delete.</Text>
          <Text style={font.small}>With a real account, this screen deletes your login and the workspaces only you use, straight from the app.</Text>
        </Card>
        <Button variant="ghost" icon="log-out" label="Leave the sample workspace" onPress={leave} loading={busy} testID="leave-sample" />
        <Button variant="ghost" icon="external-link" label="Delete account on the web" onPress={openOnWeb} testID="delete-on-web" />
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
    warning();
    if (!ready) return setError(`Type ${CONFIRM_WORD} in capitals to confirm.`);
    if (Platform.OS === "web") return run();
    Alert.alert("Delete your account for good?", "This can't be undone.", [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: run }]);
  };

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: space.xxl * 2, gap: space.lg }} keyboardShouldPersistTaps="handled">
      {/* R36: what goes, as an inset group with tiles, then the confirm fields. */}
      <InsetGroup header="What gets deleted" footer={"This can't be undone. Copies in backups expire within 30 days."}>
        <GroupRow icon="user" tile="red" label="Your login" sub={`${me?.user.email ? `${me.user.email}, ` : ""}your sessions and this phone's notifications.`} />
        <GroupRow icon="layers" tile="orange" label="Workspaces only you use" sub="With all of their mailboxes, mail, agents, tasks, projects, docs, contacts, time entries and meetings." />
        <GroupRow icon="users" tile="gray" label="Shared workspaces stay" sub="If you own a workspace other people use, make someone else an owner on the web first." />
      </InsetGroup>
      <View style={{ paddingHorizontal: space.lg, gap: space.lg }}>
      <Field label={`Type ${CONFIRM_WORD} to confirm`} value={typed} onChangeText={setTyped} autoCapitalize="characters" autoCorrect={false} testID="delete-confirm-word" />
      <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" testID="delete-password" />
      <Text style={font.tiny}>Signed up with Google? Leave the password empty.</Text>
      {error ? <Text style={{ color: colors.bad }} accessibilityRole="alert" testID="delete-error">{error}</Text> : null}
      <Button variant="danger" icon="user-x" label="Delete my account" onPress={confirm} loading={busy} disabled={!ready} testID="confirm-delete" />
      <Button variant="ghost" icon="external-link" label="Delete account on the web" onPress={openOnWeb} testID="delete-on-web" />
      </View>
    </ScrollView>
  );
}
