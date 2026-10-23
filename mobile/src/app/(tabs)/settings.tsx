import { useEffect, useState } from "react";
import { Alert, Platform, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import * as Application from "expo-application";
import * as Localization from "expo-localization";
import { Avatar, Badge, Card, Row, SectionTitle } from "@/components/ui";
import { useSession } from "@/lib/session";
import { useOverview } from "@/lib/queries";
import { enablePush, permissionGranted, type PushState } from "@/lib/push";
import { kv } from "@/lib/kv";
import { bytes } from "@/lib/format";
import { API_BASE, LINKS } from "@/config";
import { colors, font, space } from "@/theme";

const PLAN_LABEL: Record<string, string> = { free: "Free", starter: "Starter", pro: "Pro", business: "Business" };

export default function Settings() {
  const { me, mode, api, signOut } = useSession();
  const overview = useOverview();
  const [push, setPush] = useState<PushState | null>(null);
  const [allowed, setAllowed] = useState(false);
  useEffect(() => { permissionGranted().then(setAllowed).catch(() => {}); }, []);

  const turnOnPush = async () => {
    const r = await enablePush(mode === "live" ? api : null);
    setPush(r);
    setAllowed(r.kind === "allowed");
    if (r.kind === "denied") Alert.alert("Notifications are off", "Turn them on for MyMail in your phone's Settings app.");
  };
  const clearCache = async () => { await kv().clear("list:"); await kv().clear("thread:"); await kv().clear("meta:"); Alert.alert("Done", "Saved mail is cleared from this phone."); };
  const confirmSignOut = () => {
    if (Platform.OS === "web") return signOut();
    Alert.alert("Sign out?", "Mail saved on this phone is removed when you sign out.", [{ text: "Cancel", style: "cancel" }, { text: "Sign out", style: "destructive", onPress: () => signOut() }]);
  };
  const open = (url: string) => WebBrowser.openBrowserAsync(url);
  const locale = Localization.getLocales()[0];
  const used = overview.data?.reduce((n, m) => n + m.usedBytes, 0) ?? 0;

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: space.xxl }}>
      <Card style={{ margin: space.lg, flexDirection: "row", gap: space.md, alignItems: "center" }}>
        <Avatar name={me?.user.name || me?.user.email || "?"} size={48} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[font.heading, { fontSize: 17 }]} numberOfLines={1}>{me?.user.name || "Your account"}</Text>
          <Text style={font.small} numberOfLines={1}>{me?.user.email}</Text>
          <View style={{ flexDirection: "row", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
            {me?.organization ? <Badge label={`${PLAN_LABEL[me.organization.plan] ?? me.organization.plan} plan`} tone="brand" /> : null}
            {me?.user.twoFactor ? <Badge label="Two step sign in on" tone="ok" icon="shield" /> : null}
            {mode === "sample" ? <Badge label="Sample data" tone="warn" /> : null}
          </View>
        </View>
      </Card>

      <SectionTitle>Workspace</SectionTitle>
      <Row icon="briefcase" label="Workspace" value={me?.organization?.name} />
      <Row icon="inbox" label="Mailboxes" value={overview.data ? String(overview.data.filter((m) => m.kind !== "agent").length) : undefined} />
      <Row icon="cpu" label="Agent inboxes" value={overview.data ? String(overview.data.filter((m) => m.kind === "agent").length) : undefined} />
      <Row icon="hard-drive" label="Storage used" value={overview.data ? bytes(used) : undefined} />
      <Row icon="external-link" label="Domains, team and billing" onPress={() => open(`${API_BASE}/app`)} />

      <SectionTitle>Notifications</SectionTitle>
      <Row icon="bell" label={allowed ? "Notifications allowed" : "Turn on notifications"} value={allowed ? "On" : undefined} onPress={turnOnPush} testID="push" />
      {push?.kind === "allowed" ? <Text style={[font.tiny, { marginHorizontal: space.lg }]}>{push.note}</Text> : null}
      {push?.kind === "unsupported" ? <Text style={[font.tiny, { marginHorizontal: space.lg }]}>{push.reason}</Text> : null}

      <SectionTitle>This phone</SectionTitle>
      <Row icon="globe" label="Language and region" value={`English (Australia)${locale?.regionCode && locale.regionCode !== "AU" ? `, phone set to ${locale.regionCode}` : ""}`} />
      <Row icon="download" label="Clear saved mail" onPress={clearCache} />

      <SectionTitle>Help and legal</SectionTitle>
      <Row icon="activity" label="Service status" onPress={() => open(LINKS.status)} />
      <Row icon="lock" label="Privacy policy" onPress={() => open(LINKS.privacy)} />
      <Row icon="file-text" label="Terms of service" onPress={() => open(LINKS.terms)} />
      <Row icon="life-buoy" label="Contact support" onPress={() => open(LINKS.support)} />

      <SectionTitle>Account</SectionTitle>
      <Row icon="log-out" label={mode === "sample" ? "Leave the sample workspace" : "Sign out"} onPress={confirmSignOut} testID="sign-out" />
      <Row icon="user-x" label="Delete account" danger onPress={() => router.push("/delete-account")} testID="delete-account" />

      <Text style={[font.tiny, { textAlign: "center", marginTop: space.xl }]}>
        MyMail {Application.nativeApplicationVersion ?? "1.0.0"}{Application.nativeBuildVersion ? ` (${Application.nativeBuildVersion})` : ""}
      </Text>
    </ScrollView>
  );
}
