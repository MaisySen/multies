import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Banner, Button, Chip, Field, Icon, Segmented } from "@/components/ui";
import { useConnectionActions, useConnectMailbox } from "@/lib/queries";
import {
  CONNECT_PRESETS, PRESET_ORDER, connectRequest, emptyConnectForm, failedStep, presetForEmail, serversFor,
  type ConnectForm, type ConnectPresetId, type ConnectSecurity, type ConnectionView,
} from "@/lib/mail-connect";
import { ApiError } from "@/api/errors";
import { colors, font, radius, space } from "@/theme";

const STEP_LABEL = { imap: "Receiving mail (IMAP)", smtp: "Sending mail (SMTP)" } as const;
const SECURITY: { id: ConnectSecurity; label: string }[] = [{ id: "tls", label: "SSL/TLS" }, { id: "starttls", label: "STARTTLS" }];

/**
 * Connect an existing mailbox: pick the provider, type the address and an app password, then
 * Test and save. The server signs in to the provider before anything is saved and answers in plain
 * words when it can't (wrong password, app password needed, IMAP off). With ?reconnect=<id> the
 * screen only asks for a new password for a mailbox already connected.
 */
export default function ConnectMailbox() {
  const params = useLocalSearchParams<{ reconnect?: string; email?: string; preset?: string }>();
  const reconnectId = params.reconnect;
  const startPreset = (params.preset && params.preset in CONNECT_PRESETS ? params.preset : presetForEmail(params.email ?? "") ?? "gmail") as ConnectPresetId;
  const [form, setForm] = useState<ConnectForm>(() => ({ ...emptyConnectForm(startPreset), email: params.email ?? "" }));
  const [picked, setPicked] = useState(!!params.preset);
  const [error, setError] = useState<{ text: string; step: "imap" | "smtp" | null } | null>(null);
  const [done, setDone] = useState<ConnectionView | null>(null);
  const connect = useConnectMailbox();
  const { reconnect } = useConnectionActions();
  const busy = connect.isPending || reconnect.isPending;
  const preset = CONNECT_PRESETS[form.preset];
  const set = (patch: Partial<ConnectForm>) => { setForm((f) => ({ ...f, ...patch })); setError(null); };

  const presetPatch = (id: ConnectPresetId, email: string): Partial<ConnectForm> => {
    const s = serversFor(id, email);
    return { preset: id, imapHost: s.imap.host, imapPort: String(s.imap.port), imapSecurity: s.imap.security, smtpHost: s.smtp.host, smtpPort: String(s.smtp.port), smtpSecurity: s.smtp.security };
  };
  const choose = (id: ConnectPresetId) => { setPicked(true); set(presetPatch(id, form.email)); };
  const typeEmail = (email: string) => {
    // Until a provider is picked by hand, the address picks it (gmail.com is Gmail, and so on).
    const guess = picked ? null : presetForEmail(email);
    set(guess ? { email, ...presetPatch(guess, email) } : { email });
  };

  const fail = (e: unknown) => {
    if (e instanceof ApiError) setError({ text: e.message, step: failedStep(e.details) });
    else setError({ text: "That didn't work. Check your connection and try again.", step: null });
  };

  const submit = () => {
    setError(null);
    if (reconnectId) {
      if (!form.password) return setError({ text: "Paste the new app password for this mailbox.", step: null });
      reconnect.mutate({ id: reconnectId, password: form.password }, { onSuccess: (r) => setDone(r.connection), onError: fail });
      return;
    }
    const r = connectRequest(form);
    if ("error" in r) return setError({ text: r.error, step: null });
    connect.mutate(r.body, { onSuccess: (x) => setDone(x.connection), onError: fail });
  };

  if (done) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, padding: space.xl, gap: space.lg, alignItems: "center", justifyContent: "center" }} testID="connect-done">
        <Stack.Screen options={{ title: reconnectId ? "Reconnected" : "Connected" }} />
        <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: colors.okSoft, alignItems: "center", justifyContent: "center" }}>
          <Icon name="check" size={28} color={colors.ok} />
        </View>
        <Text style={[font.heading, { textAlign: "center" }]}>{done.email} is connected</Text>
        <Text style={[font.small, { textAlign: "center", maxWidth: 320 }]}>
          Your recent mail is syncing now, and new mail keeps arriving on its own. You can send as this address from Compose.
        </Text>
        <Button label="Open inbox" icon="inbox" testID="open-inbox" onPress={() => router.replace("/inbox")} style={{ alignSelf: "stretch" }} />
        <Button label="Done" variant="ghost" onPress={() => (router.canGoBack() ? router.back() : router.replace("/inbox"))} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: reconnectId ? "Reconnect" : "Connect your email" }} />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xxl * 2 }} keyboardShouldPersistTaps="handled" testID="connect-mailbox">
        {reconnectId ? (
          <Text style={font.small}>The provider stopped accepting the saved password for {params.email}. Paste a new app password to start syncing again.</Text>
        ) : (
          <View style={{ gap: space.sm }}>
            <Text style={{ color: colors.muted, fontSize: 14, fontWeight: "500" }}>Provider</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }} testID="presets">
              {PRESET_ORDER.map((id) => <Chip key={id} label={CONNECT_PRESETS[id].label} selected={form.preset === id} onPress={() => choose(id)} />)}
            </View>
          </View>
        )}

        {!reconnectId ? (
          <Field label="Email address" testID="connect-email" value={form.email} onChangeText={typeEmail} autoCapitalize="none" autoCorrect={false}
            keyboardType="email-address" autoComplete="email" textContentType="emailAddress" placeholder="name@example.com" />
        ) : null}
        <Field label={preset.id === "gmx" || preset.id === "custom" ? "Password" : "App password"} testID="connect-password" value={form.password}
          onChangeText={(password) => set({ password })} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" textContentType="password"
          hint={preset.help} />
        {preset.appPasswordUrl ? (
          <Button variant="ghost" icon="external-link" label={`Make an app password at ${preset.label}`} testID="app-password-link"
            onPress={() => WebBrowser.openBrowserAsync(preset.appPasswordUrl!)} style={{ alignSelf: "flex-start", minHeight: 36, paddingHorizontal: 0 }} />
        ) : null}
        {preset.oauthPreferred && !reconnectId ? (
          <Banner tone="warn" icon="info" text="Microsoft turns off app passwords on many accounts. If the test says Microsoft's own sign in is needed, use a free address or your own domain for now." />
        ) : null}

        {preset.id === "custom" && !reconnectId ? (
          <View style={{ gap: space.md, backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.lg }} testID="custom-servers">
            <Text style={[font.heading, { fontSize: 15 }]}>Receiving (IMAP)</Text>
            <Field label="IMAP server" testID="imap-host" value={form.imapHost} onChangeText={(imapHost) => set({ imapHost })} autoCapitalize="none" autoCorrect={false} placeholder="imap.example.com" />
            <Field label="IMAP port" testID="imap-port" value={form.imapPort} onChangeText={(imapPort) => set({ imapPort })} keyboardType="number-pad" />
            <Segmented label="IMAP security" value={form.imapSecurity} options={SECURITY} onChange={(imapSecurity) => set({ imapSecurity })} />
            <Text style={[font.heading, { fontSize: 15, marginTop: space.sm }]}>Sending (SMTP)</Text>
            <Field label="SMTP server" testID="smtp-host" value={form.smtpHost} onChangeText={(smtpHost) => set({ smtpHost })} autoCapitalize="none" autoCorrect={false} placeholder="smtp.example.com" />
            <Field label="SMTP port" testID="smtp-port" value={form.smtpPort} onChangeText={(smtpPort) => set({ smtpPort })} keyboardType="number-pad" />
            <Segmented label="SMTP security" value={form.smtpSecurity} options={SECURITY} onChange={(smtpSecurity) => set({ smtpSecurity })} />
            <Field label="User name, if it isn't the email address" testID="connect-username" value={form.username} onChangeText={(username) => set({ username })} autoCapitalize="none" autoCorrect={false} />
          </View>
        ) : null}

        {error ? (
          <View style={{ backgroundColor: colors.badSoft, borderRadius: radius.md, padding: space.md, gap: 4 }} accessibilityRole="alert" testID="connect-error">
            {error.step ? <Text style={{ color: colors.bad, fontSize: 13, fontWeight: "600" }}>{STEP_LABEL[error.step]}</Text> : null}
            <Text style={{ color: colors.bad, fontSize: 15 }}>{error.text}</Text>
          </View>
        ) : null}

        <Button label={busy ? "Checking the connection" : reconnectId ? "Test and reconnect" : "Test and save"} icon="check-circle" testID="connect-submit"
          loading={busy} disabled={busy} onPress={submit} />
        <Text style={font.tiny}>
          Multies signs in to your provider to check the details before saving. The password is stored encrypted, used only to sync and send for this mailbox, and deleted when you remove it.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
