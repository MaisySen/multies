/**
 * M1 (1.10.9): calendar and contacts sync (flag davSync), as on the web's sync guide: make an app password (shown once,
 * with Copy), list and revoke them, the server address and user name, and short iPhone and Android steps.
 */
import { useState } from "react";
import { Alert, Platform, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { Stack } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { Button, Loading, Segmented } from "@/components/ui";
import { GroupRow, InsetGroup } from "@/components/grouped";
import { Footnote, LoadError, NoAccess } from "@/components/m1-work";
import { confirmThen, FeatureOff, problemText } from "@/components/m1-more";
import { noAccess, notFoundErr } from "@/lib/contacts-queries";
import { useAppPasswords, useCreateAppPassword, useRevokeAppPassword } from "@/lib/m1-more-queries";
import { APP_PASSWORD_NAME_MAX, guideSteps, passwordName, type SyncGuide } from "@/lib/dav-sync";
import { shortDate } from "@/lib/mail-merge";
import { flagOn, useWebConfig } from "@/lib/web-config";
import { colors, font, radius, space, TOUCH } from "@/theme";

export default function Sync() {
  const cfg = useWebConfig();
  const on = cfg.data ? flagOn(cfg.data, "davSync") : true;
  const list = useAppPasswords(on);
  const create = useCreateAppPassword();
  const revoke = useRevokeAppPassword();
  const [name, setName] = useState("");
  const [made, setMade] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [guide, setGuide] = useState<SyncGuide>(Platform.OS === "android" ? "android" : "iphone");
  const header = <Stack.Screen options={{ title: "Calendar and contacts sync" }} />;

  if (!on || notFoundErr(list.error)) return <>{header}<FeatureOff title="Sync is off" body="Calendar and contacts sync is not switched on for this workspace." /></>;
  if (noAccess(list.error)) return <>{header}<NoAccess what="Sync" /></>;
  if (list.isPending) return <>{header}<Loading label="Loading sync" rows={4} /></>;
  if (list.error || !list.data) return <>{header}<LoadError title="Couldn't load sync" error={list.error} onRetry={() => list.refetch()} /></>;

  const d = list.data;
  const full = d.passwords.length >= d.max;
  const copy = async (what: string, value: string) => { await Clipboard.setStringAsync(value); setCopied(what); };
  const make = () => create.mutate(passwordName(name), {
    onSuccess: (r) => { setMade(r.password); setName(""); setCopied(null); },
    onError: (e) => Alert.alert("Couldn't make an app password", problemText(e)),
  });

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ paddingTop: space.md, paddingBottom: space.xxl, gap: space.lg }}
      keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={list.isRefetching} onRefresh={() => { list.refetch(); }} />} testID="sync">
      {header}
      <View style={{ paddingHorizontal: space.lg }}>
        <Footnote>{"Your calendar and contacts can show in your phone's own Calendar and Contacts apps. Sign in there with an app password, not your Multies password."}</Footnote>
      </View>

      <InsetGroup header="Your details">
        <GroupRow icon="globe" tile="blue" label="Server address" sub={d.server} onPress={() => copy("server", d.server)} hint="Copies the server address"
          value={copied === "server" ? "Copied" : "Copy"} testID="sync-server" />
        <GroupRow icon="user" tile="teal" label="User name" sub={d.username} onPress={() => copy("username", d.username)} hint="Copies your user name"
          value={copied === "username" ? "Copied" : "Copy"} testID="sync-username" />
      </InsetGroup>

      {made ? (
        <View style={{ marginHorizontal: space.lg, padding: space.lg, gap: space.sm, borderRadius: radius.lg, backgroundColor: colors.elevated }} testID="sync-made">
          <Text style={font.headline}>Your new app password</Text>
          <Text selectable style={{ color: colors.fg, fontSize: 20, letterSpacing: 1, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" }} testID="sync-made-password">{made}</Text>
          <Text style={font.small}>{"Copy it now. You won't see it again."}</Text>
          <Button label={copied === "password" ? "Copied" : "Copy password"} icon="copy" onPress={() => copy("password", made)} testID="sync-copy" />
          <Button label="Done" variant="secondary" onPress={() => { setMade(null); setCopied(null); }} testID="sync-done" />
        </View>
      ) : (
        <InsetGroup header="Make an app password" footer={full ? `You have the most app passwords allowed (${d.max}). Revoke one to make another.` : "Give it the name of the phone or app it is for."}>
          <View style={{ padding: space.md, gap: space.sm }}>
            <TextInput value={name} onChangeText={setName} placeholder="My phone" placeholderTextColor={colors.subtle} maxLength={APP_PASSWORD_NAME_MAX}
              accessibilityLabel="App password name" testID="sync-name" editable={!full}
              style={{ minHeight: TOUCH, color: colors.fg, fontSize: 17, paddingHorizontal: space.md, borderRadius: radius.md, backgroundColor: colors.bg }} />
            <Button label="Make app password" icon="key" onPress={make} loading={create.isPending} disabled={full} testID="sync-make" />
          </View>
        </InsetGroup>
      )}

      <InsetGroup header="App passwords" testID="sync-list">
        {d.passwords.length ? d.passwords.map((p) => (
          <GroupRow key={p.id} icon="key" tile="gray" label={p.name}
            sub={p.lastUsedAt ? `Made ${shortDate(p.createdAt)}, last used ${shortDate(p.lastUsedAt)}` : `Made ${shortDate(p.createdAt)}, not used yet`}
            right={<Button label="Revoke" variant="secondary" loading={revoke.isPending && revoke.variables === p.id}
              onPress={() => confirmThen("Revoke this app password?", `Anything signed in with "${p.name}" stops syncing.`, "Revoke",
                () => revoke.mutate(p.id, { onError: (e) => Alert.alert("Couldn't revoke", problemText(e)) }), true)} testID={`sync-revoke-${p.id}`} />}
            testID={`sync-pw-${p.id}`} />
        )) : <GroupRow icon="key" tile="gray" label="No app passwords yet" testID="sync-none" />}
      </InsetGroup>

      <View style={{ paddingHorizontal: space.lg, gap: space.sm }}>
        <Text style={font.headline} accessibilityRole="header">Set it up</Text>
        <Segmented<SyncGuide> label="Phone" value={guide} onChange={setGuide} options={[{ id: "iphone", label: "iPhone" }, { id: "android", label: "Android" }]} />
        <View style={{ gap: space.sm }} testID="sync-steps">
          {guideSteps(guide, d.server).map((s, i) => (
            <Text key={i} style={font.body}>{`${i + 1}. ${s}`}</Text>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}
