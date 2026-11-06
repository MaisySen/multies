import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { ScreenHeader } from "@/components/m3-ui";
import { InsetGroup, GroupRow } from "@/components/grouped";
import { Button, Field } from "@/components/ui";
import { colors, font, space } from "@/theme";
import { tr } from "@/i18n";
import { canChangePassword, cleanName, passwordProblem, phoneTimeZone } from "@/lib/mpar2";
import { useChangePassword, useMeFull, useSavePreferences, useUpdateName } from "@/lib/mpar2-queries";
import { useSession } from "@/lib/session";
import { openWeb } from "@/lib/web-open";
import { router } from "expo-router";

const errText = (e: unknown, fallback: string) => {
  const m = (e as { message?: string } | null)?.message;
  return m && !/^HTTP|fetch|network/i.test(m) ? m : fallback;
};

/**
 * MPAR2: Settings > Account. Name, password and time zone, through the web app's own routes (Better Auth for the name
 * and password, /api/account/preferences for the time zone). A Multies sign in (identity provider) has no password
 * here: its page opens in the in-app browser instead.
 */
export default function AccountScreen() {
  const { me, mode } = useSession();
  const full = useMeFull();
  const user = full.data?.user ?? me?.user;
  const [name, setName] = useState(user?.name ?? "");
  useEffect(() => { if (user?.name) setName(user.name); }, [user?.name]);
  const saveName = useUpdateName();
  const [nameMsg, setNameMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const change = useChangePassword();
  const prefs = useSavePreferences();
  const [tzMsg, setTzMsg] = useState<string | null>(null);
  const sample = mode === "sample";
  const hasPw = canChangePassword(full.data);
  const zone = full.data?.user.timezone ?? null;
  const phoneZone = phoneTimeZone();

  const onSaveName = async () => {
    const v = cleanName(name);
    if (!v) { setNameMsg({ ok: false, text: tr("m.account.name_needed") }); return; }
    setNameMsg(null);
    try { await saveName.mutateAsync(v); setNameMsg({ ok: true, text: tr("m.account.name_saved") }); }
    catch (e) { setNameMsg({ ok: false, text: errText(e, tr("m.account.couldn_t_save")) }); }
  };
  const onChangePw = async () => {
    const p = passwordProblem(current, next);
    if (p) { setPwMsg({ ok: false, text: p }); return; }
    setPwMsg(null);
    try {
      await change.mutateAsync({ currentPassword: current, newPassword: next });
      setCurrent(""); setNext("");
      setPwMsg({ ok: true, text: tr("m.account.password_changed_others_out") });
    } catch (e) { setPwMsg({ ok: false, text: errText(e, tr("m.account.couldn_t_change_password")) }); }
  };
  const useZone = async () => {
    if (!phoneZone) return;
    try { await prefs.mutateAsync({ timezone: phoneZone }); await full.refetch(); setTzMsg(tr("m.account.time_zone_saved")); }
    catch (e) { setTzMsg(errText(e, tr("m.account.couldn_t_save"))); }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="account-screen">
      <ScreenHeader title={tr("m.account.title")} back={tr("nav.settings")} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, gap: space.lg }} keyboardShouldPersistTaps="handled">
        <View style={st.card}>
          <Text style={st.h} accessibilityRole="header">{tr("m.account.your_name")}</Text>
          <Field label={tr("common.name")} value={name} onChangeText={setName} autoComplete="name" textContentType="name" maxLength={100} testID="account-name" editable={!sample} />
          <Text style={st.sub}>{tr("m.account.email_line", { email: user?.email ?? "" })}</Text>
          {nameMsg ? <Text style={[st.msg, { color: nameMsg.ok ? colors.ok : colors.bad }]} accessibilityLiveRegion="polite" testID="account-name-msg">{nameMsg.text}</Text> : null}
          <Button label={tr("common.save")} onPress={onSaveName} loading={saveName.isPending} disabled={sample || !cleanName(name) || cleanName(name) === user?.name} variant="secondary" testID="account-name-save" />
        </View>

        <View style={st.card}>
          <Text style={st.h} accessibilityRole="header">{tr("common.password")}</Text>
          {hasPw ? (
            <>
              <Text style={st.sub}>{tr("settings.changing_it_signs_you_out_on_every_other_device")}</Text>
              <Field label={tr("settings.current_password")} value={current} onChangeText={setCurrent} secureTextEntry autoComplete="current-password" textContentType="password" testID="account-current" editable={!sample} />
              <Field label={tr("settings.new_password")} hint={tr("settings.at_least_10_characters")} value={next} onChangeText={setNext} secureTextEntry autoComplete="new-password" textContentType="newPassword" testID="account-new" editable={!sample} />
              {pwMsg ? <Text style={[st.msg, { color: pwMsg.ok ? colors.ok : colors.bad }]} accessibilityLiveRegion="polite" testID="account-pw-msg">{pwMsg.text}</Text> : null}
              <Button label={tr("settings.update_password")} onPress={onChangePw} loading={change.isPending} disabled={sample || !current || next.length < 10} variant="secondary" testID="account-pw-save" />
            </>
          ) : (
            <>
              <Text style={st.sub}>{tr("settings.you_signed_in_with_multies_sign_in_so_there_s_no")}</Text>
              <Text style={st.sub}>{tr("m.account.sign_in_page_note")}</Text>
              <Button label={tr("m.account.open_sign_in_settings")} icon="external-link" variant="secondary" onPress={() => openWeb("/app/settings/account")} testID="account-idp" />
            </>
          )}
          {sample ? <Text style={st.sub}>{tr("m.account.sample_note")}</Text> : null}
        </View>

        <InsetGroup header={tr("m.account.general")} style={{ marginTop: 0 }} footer={tzMsg ?? undefined}>
          <GroupRow label={tr("settings.time_zone")} value={zone ?? tr("m.account.workspace_zone")} icon="clock" tile="indigo" />
          {phoneZone && phoneZone !== zone && !sample ? <GroupRow label={tr("m.account.use_phone_zone", { zone: phoneZone })} icon="smartphone" tile="blue" onPress={useZone} testID="account-zone" /> : null}
          <GroupRow label={tr("appearance.language")} icon="globe" tile="blue" onPress={() => router.push("/language")} chevron testID="account-language" />
          <GroupRow label={tr("m.account.devices_and_two_step")} icon="shield" tile="green" onPress={() => openWeb("/app/settings/account")} chevron testID="account-web" />
        </InsetGroup>
      </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
const st = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: 14, padding: space.lg, gap: space.md },
  h: { ...font.headline },
  sub: { ...font.small },
  msg: { fontSize: 15, lineHeight: font.small.lineHeight },
});
