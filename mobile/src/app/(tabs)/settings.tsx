import { useEffect, useState } from "react";
import { Alert, Platform, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import * as Localization from "expo-localization";
import { Avatar, Badge, Card, LargeTitle, Row, SectionTitle, Segmented } from "@/components/ui";
import { useUndoSeconds, parseUndoSeconds, UNDO_SEND_CHOICES } from "@/lib/undo-send";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useSession } from "@/lib/session";
import { useBlocks, useNotificationCount, useOverview } from "@/lib/queries";
import { permissionGranted, registerPush, type PushState } from "@/lib/push";
import { kv } from "@/lib/kv";
import { bytes } from "@/lib/format";
import { LINKS, WEB_PAGES } from "@/config";
import { colors, font, space } from "@/theme";
import { currentVersionFacts, updateDetail, versionLabel } from "@/lib/app-version";
import { UpdateRows } from "@/components/update-rows";
import { GestureSettings } from "@/components/gesture-settings";

const PLAN_LABEL: Record<string, string> = { free: "Free", starter: "Starter", pro: "Pro", business: "Business" };

export default function Settings() {
  const { me, mode, api, signOut } = useSession();
  const overview = useOverview();
  const inbox = useNotificationCount();
  const [undoSeconds, setUndoSeconds] = useUndoSeconds();
  const insets = useSafeAreaInsets();
  const blocksQ = useBlocks();
  const version = currentVersionFacts();
  const [push, setPush] = useState<PushState | null>(null);
  const [allowed, setAllowed] = useState(false);
  useEffect(() => { permissionGranted().then(setAllowed).catch(() => {}); }, []);

  const turnOnPush = async () => {
    const r = await registerPush(mode === "live" ? api : null, { prompt: true });
    setPush(r);
    setAllowed(r.kind === "allowed");
    if (r.kind === "denied") Alert.alert("Notifications are off", "Turn them on for Multies in your phone's Settings app.");
  };
  const clearCache = async () => {
    for (const p of ["list:", "thread:", "meta:", "task:", "worklist:"]) await kv().clear(p);
    Alert.alert("Done", "Saved mail and tasks are cleared from this phone.");
  };
  const confirmSignOut = () => {
    if (Platform.OS === "web") return signOut();
    Alert.alert("Sign out?", "Mail and tasks saved on this phone are removed when you sign out.", [{ text: "Cancel", style: "cancel" }, { text: "Sign out", style: "destructive", onPress: () => signOut() }]);
  };
  const open = (url: string) => WebBrowser.openBrowserAsync(url);
  const blockedCount = blocksQ.data?.blocks.length ?? 0;
  const locale = Localization.getLocales()[0];
  const used = overview.data?.reduce((n, m) => n + m.usedBytes, 0) ?? 0;

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: space.xxl }}>
      <LargeTitle title="Settings" top={insets.top} />
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
      <Row tile="indigo" icon="briefcase" label="Workspace" value={me?.organization?.name} onPress={() => router.push("/workspaces")} testID="workspaces-link" />
      <Row tile="blue" icon="inbox" label="Email addresses" value={overview.data ? String(overview.data.filter((m) => m.kind !== "agent").length) : undefined} onPress={() => router.push("/email-setup")} testID="email-setup-link" />
      <Row tile="purple" icon="cpu" label="Agent inboxes" value={overview.data ? String(overview.data.filter((m) => m.kind === "agent").length) : undefined} />
      <Row tile="gray" icon="hard-drive" label="Storage used" value={overview.data ? bytes(used) : undefined} />
      <Row tile="green" icon="video" label="Meetings" onPress={() => router.push("/meetings")} testID="meetings" />
      <Row tile="orange" icon="layers" label="Portfolio" onPress={() => router.push("/portfolio")} testID="portfolio-link" />
      <Row tile="teal" icon="users" label="People" onPress={() => router.push("/people")} testID="people-link" />
      <Row tile="purple" icon="bot" label="Agent runs" onPress={() => router.push("/runs")} testID="runs-link" />
      <Row tile="gray" icon="external-link" label="Domains and team, on the web" onPress={() => open(WEB_PAGES.team)} />

      <SectionTitle>Notifications</SectionTitle>
      <Row tile="red" icon="inbox" label="Notifications inbox" value={inbox.data ? `${inbox.data} unread` : undefined} onPress={() => router.push("/notifications")} testID="notifications-link" />
      <Row tile="red" icon="sliders" label="Notification settings" onPress={() => router.push("/notification-settings")} testID="notification-settings-link" />
      <Row tile="red" icon="bell" label={allowed ? "Notifications allowed" : "Turn on notifications"} value={allowed ? "On" : undefined} onPress={turnOnPush} testID="push" />
      {push?.kind === "allowed" ? <Text style={[font.tiny, { marginHorizontal: space.lg }]}>{push.note}</Text> : null}
      {push?.kind === "unsupported" ? <Text style={[font.tiny, { marginHorizontal: space.lg }]}>{push.reason}</Text> : null}

      <SectionTitle>This phone</SectionTitle>
      <Row tile="blue" icon="globe" label="Language and region" value={`English (Australia)${locale?.regionCode && locale.regionCode !== "AU" ? `, phone set to ${locale.regionCode}` : ""}`} />
      <Row tile="gray" icon="download" label="Clear saved mail" onPress={clearCache} />
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm, gap: space.sm }} testID="undo-send-setting">
        <Text style={{ color: colors.fg, fontSize: 16 }} nativeID="undo-send-label">Undo send</Text>
        <Segmented label="Undo send window" value={String(undoSeconds)} onChange={(v) => setUndoSeconds(parseUndoSeconds(v))}
          options={UNDO_SEND_CHOICES.map((n) => ({ id: String(n), label: `${n} s` }))} />
        <Text style={{ color: colors.subtle, fontSize: 13 }}>How long you have to take a message back after Send. Saved on this phone.</Text>
      </View>

      <GestureSettings />

      <UpdateRows />

      <SectionTitle>Privacy and safety</SectionTitle>
      <Row tile="red" icon="user-x" label="Blocked people" value={blockedCount ? String(blockedCount) : undefined} onPress={() => router.push("/blocked")} testID="blocked-link" />
      <Row tile="gray" icon="flag" label="Community rules" onPress={() => open(LINKS.terms)} testID="community-rules" />
      <Text style={[font.tiny, { marginHorizontal: space.lg, marginTop: space.xs }]}>To report a message, press and hold it in chat. Our team reviews reports within 24 hours.</Text>

      <SectionTitle>Help and legal</SectionTitle>
      <Row tile="green" icon="activity" label="Service status" onPress={() => open(LINKS.status)} />
      <Row tile="blue" icon="lock" label="Privacy policy" onPress={() => open(LINKS.privacy)} />
      <Row tile="gray" icon="file-text" label="Terms of service" onPress={() => open(LINKS.terms)} />
      <Row tile="orange" icon="life-buoy" label="Contact support" onPress={() => open(LINKS.support)} />

      <SectionTitle>Account</SectionTitle>
      <Row tile="gray" icon="log-out" label={mode === "sample" ? "Leave the sample workspace" : "Sign out"} onPress={confirmSignOut} testID="sign-out" />
      <Row icon="user-x" label="Delete my account" danger onPress={() => router.push("/delete-account")} testID="delete-account" />

      <Text style={[font.tiny, { textAlign: "center", marginTop: space.xl }]} testID="app-version">
        {versionLabel(version)}
      </Text>
      {updateDetail(version) ? (
        <Text style={[font.tiny, { textAlign: "center", marginTop: space.xs }]} testID="app-update">{updateDetail(version)}</Text>
      ) : null}
    </ScrollView>
  );
}
