import { useInboxBadge, useSocialStatus } from "@/lib/social-queries";
import { badgeText } from "@/lib/social-inbox";
import { useEffect, useState } from "react";
import { Alert, Platform, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import * as Localization from "expo-localization";
import { Avatar, Badge, Card, LargeTitle, Row, SectionTitle, Segmented } from "@/components/ui";
import { useUndoSeconds, parseUndoSeconds, UNDO_SEND_CHOICES } from "@/lib/undo-send";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useSession } from "@/lib/session";
import { flagOn, toolFeatureOn, useWebConfig } from "@/lib/web-config";
import { useBlocks, useNotificationCount, useOverview, useTools } from "@/lib/queries";
import { useFilesAccess } from "@/lib/drive-queries";
import { permissionGranted, registerPush, type PushState } from "@/lib/push";
import { kv } from "@/lib/kv";
import { bytes } from "@/lib/format";
import { LINKS, WEB_PAGES } from "@/config";
import { colors, font, space } from "@/theme";
import { currentVersionFacts, updateDetail, versionLabel } from "@/lib/app-version";
import { UpdateRows } from "@/components/update-rows";
import { GestureSettings } from "@/components/gesture-settings";
import { biometricAvailable, biometricLabel, getBiometricLock, setBiometricLock } from "@/lib/native-features";

const PLAN_LABEL: Record<string, string> = { free: "Free", starter: "Starter", pro: "Pro", business: "Business" };

export default function Settings() {
  const { me, mode, api, signOut } = useSession();
  const overview = useOverview();
  const inbox = useNotificationCount();
  const [undoSeconds, setUndoSeconds] = useUndoSeconds();
  const insets = useSafeAreaInsets();
  const blocksQ = useBlocks();
  const tools = useTools();
  const files = useFilesAccess();
  // 1.10.8: open conversations in the Social inbox, shown on the Social row.
  const socialSt = useSocialStatus();
  const socialInbox = badgeText(useInboxBadge(!!socialSt.data?.available).data);
  // M1 (1.10.9): the web's feature flags, for the Contacts, Mail merge, Mail archive and Sync rows.
  const webCfg = useWebConfig();
  const version = currentVersionFacts();
  const [push, setPush] = useState<PushState | null>(null);
  const [allowed, setAllowed] = useState(false);
  useEffect(() => { permissionGranted().then(setAllowed).catch(() => {}); }, []);
  // R37: "Unlock with Face ID" (or fingerprint), off by default; shows only where the phone supports it.
  const [lockAvailable, setLockAvailable] = useState(false);
  const [lockLabel, setLockLabel] = useState("Face ID");
  const [lockOn, setLockOn] = useState(false);
  useEffect(() => {
    biometricAvailable().then(setLockAvailable).catch(() => {});
    biometricLabel().then(setLockLabel).catch(() => {});
    getBiometricLock().then(setLockOn).catch(() => {});
  }, []);
  const toggleLock = async () => {
    const next = await setBiometricLock(!lockOn).catch(() => lockOn);
    if (!lockOn && !next) Alert.alert(`Couldn't turn on ${lockLabel}`, "Check that it is set up in your phone's Settings app, then try again.");
    setLockOn(next);
  };

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
      <Row tile="blue" icon="filter" label="Mail" value="Tabs and rules" onPress={() => router.push("/mail-settings")} testID="mail-settings-link" />
      <Row tile="blue" icon="inbox" label="Email addresses" value={overview.data ? String(overview.data.filter((m) => m.kind !== "agent").length) : undefined} onPress={() => router.push("/email-setup")} testID="email-setup-link" />
      <Row tile="purple" icon="cpu" label="Agent inboxes" value={overview.data ? String(overview.data.filter((m) => m.kind === "agent").length) : undefined} />
      <Row tile="gray" icon="hard-drive" label="Storage used" value={overview.data ? bytes(used) : undefined} />
      {files.on ? <Row tile="blue" icon="layers" label="Files" value="Team, mine and brand" onPress={() => router.push("/files")} testID="files-link" /> : null}
      {tools.data ? <Row tile="brand" icon="wrench" label="Tools" value="PDF and Office" onPress={() => router.push("/tools")} testID="tools-link" /> : null}
      <Row tile="pink" icon="send" label="Social" value={socialInbox ? `${socialInbox} open in inbox` : "Posts, inbox and accounts"} onPress={() => router.push("/social")} testID="social-link" />
      {me?.organization ? <Row tile="blue" icon="file-text" label="Docs" value="Read, comment and share" onPress={() => router.push("/docs")} testID="docs-link" /> : null}
      <Row tile="green" icon="video" label="Meetings" onPress={() => router.push("/meetings")} testID="meetings" />
      <Row tile="orange" icon="layers" label="Portfolio" onPress={() => router.push("/portfolio")} testID="portfolio-link" />
      {me?.organization ? <Row tile="blue" icon="user" label="Contacts" value={webCfg.data?.maps === true ? "People and visits" : undefined} onPress={() => router.push("/contacts")} testID="contacts-link" /> : null}
      {me?.organization && webCfg.data && toolFeatureOn(webCfg.data, "merge_plus_r109") ? <Row tile="blue" icon="mail" label="Mail merge" value="Newsletters and journeys" onPress={() => router.push("/mail-merge")} testID="mail-merge-link" /> : null}
      {me?.organization && flagOn(webCfg.data, "mailArchive") ? <Row tile="indigo" icon="archive" label="Mail archive" value="Retention and holds" onPress={() => router.push("/mail-archive")} testID="mail-archive-link" /> : null}
      {me?.organization && flagOn(webCfg.data, "davSync") ? <Row tile="green" icon="calendar" label="Calendar and contacts sync" onPress={() => router.push("/sync")} testID="sync-link" /> : null}
      <Row tile="teal" icon="users" label="People" onPress={() => router.push("/people")} testID="people-link" />
      <Row tile="purple" icon="bot" label="Agent runs" onPress={() => router.push("/runs")} testID="runs-link" />
      <Row tile="gray" icon="external-link" label="Domains and team, on the web" onPress={() => open(WEB_PAGES.team)} />

      {lockAvailable ? (
        <>
          <SectionTitle>Security</SectionTitle>
          <Row tile="green" icon="lock" label={`Unlock with ${lockLabel}`} value={lockOn ? "On" : "Off"} onPress={toggleLock} testID="biometric-lock" />
        </>
      ) : null}

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
