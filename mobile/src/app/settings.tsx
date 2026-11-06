import { useCallback, useEffect, useState } from "react";
import { Alert, Platform, ScrollView, Text, View } from "react-native";
import * as ExpoRouter from "expo-router";
import { router } from "expo-router";
import { ScreenHeader } from "@/components/m3-ui";
import { Avatar, Badge, Card, Row, SectionTitle, Segmented } from "@/components/ui";
import { useUndoSeconds, parseUndoSeconds, UNDO_SEND_CHOICES } from "@/lib/undo-send";

import { useSession } from "@/lib/session";
import { flagOn, toolFeatureOn, useWebConfig } from "@/lib/web-config";
import { useBlocks, useNotificationCount, useOverview } from "@/lib/queries";
import { permissionGranted, registerPush, type PushState } from "@/lib/push";
import { kv } from "@/lib/kv";
import { bytes } from "@/lib/format";
import { LINKS, WEB_PAGES } from "@/config";
import { colors, font, space, scheme, mode as themeMode, accent as themeAccent } from "@/theme";
import { LANG_NAMES, currentLang, savedChoice } from "@/i18n";
import { checklistVisible } from "@/lib/mpar2";
import { useToursMe } from "@/lib/mpar2-queries";
import { currentVersionFacts, updateDetail, versionLabel } from "@/lib/app-version";
import { UpdateRows } from "@/components/update-rows";
import { GestureSettings } from "@/components/gesture-settings";
import { getLockSettings } from "@/lib/app-lock";
import { openWeb } from "@/lib/web-open";
import { tr } from "@/i18n";

const PLAN_LABEL: Record<string, string> = { free: tr("m.settings.free"), starter: tr("m.settings.starter"), pro: tr("m.settings.pro"), business: tr("m.settings.business") };

/** Re-reads on focus (back from Lock Multies); a plain effect where the router has no focus hook (tests). */
const useFocus: (cb: () => void) => void = typeof ExpoRouter.useFocusEffect === "function" ? ExpoRouter.useFocusEffect : (cb) => { useEffect(cb, [cb]); };

export default function Settings() {
  const { me, mode, api, signOut } = useSession();
  const overview = useOverview();
  const inbox = useNotificationCount();
  const [undoSeconds, setUndoSeconds] = useUndoSeconds();
  const blocksQ = useBlocks();
  // M1 (1.10.9): the web's feature flags, for the Contacts, Mail merge, Mail archive and Sync rows.
  const webCfg = useWebConfig();
  const version = currentVersionFacts();
  const [push, setPush] = useState<PushState | null>(null);
  const [allowed, setAllowed] = useState(false);
  useEffect(() => { permissionGranted().then(setAllowed).catch(() => {}); }, []);
  // R37: "Unlock with Face ID" (or fingerprint), off by default; shows only where the phone supports it.
  const [lockOn, setLockOn] = useState(false);
  useFocus(useCallback(() => { getLockSettings().then((l) => setLockOn(l.on)).catch(() => {}); }, []));

  const turnOnPush = async () => {
    const r = await registerPush(mode === "live" ? api : null, { prompt: true });
    setPush(r);
    setAllowed(r.kind === "allowed");
    if (r.kind === "denied") Alert.alert(tr("m.settings.notifications_are_off"), tr("m.settings.turn_them_on_for_multies_in_your_phone_s_setting"));
  };
  const clearCache = async () => {
    for (const p of ["list:", "thread:", "meta:", "task:", "worklist:"]) await kv().clear(p);
    Alert.alert(tr("m.settings.done"), tr("m.settings.saved_mail_and_tasks_are_cleared_from_this_phone"));
  };
  const confirmSignOut = () => {
    if (Platform.OS === "web") return signOut();
    Alert.alert(tr("m.settings.sign_out"), tr("m.settings.mail_and_tasks_saved_on_this_phone_are_removed_w"), [{ text: tr("m.settings.cancel"), style: "cancel" }, { text: tr("m.settings.sign_out_2"), style: "destructive", onPress: () => signOut() }]);
  };
  const open = (url: string) => openWeb(url); // M3: inside the app, signed in for the web app's pages
  const blockedCount = blocksQ.data?.blocks.length ?? 0;
  const tours = useToursMe();
  const used = overview.data?.reduce((n, m) => n + m.usedBytes, 0) ?? 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="settings-screen">
    <ScreenHeader title={tr("m.settings.settings")} />
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: space.xxl }}>
      <Card style={{ margin: space.lg, flexDirection: "row", gap: space.md, alignItems: "center" }}>
        <Avatar name={me?.user.name || me?.user.email || "?"} size={48} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[font.heading, { fontSize: 17 }]} numberOfLines={1}>{me?.user.name || tr("m.settings.your_account")}</Text>
          <Text style={font.small} numberOfLines={1}>{me?.user.email}</Text>
          <View style={{ flexDirection: "row", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
            {me?.organization ? <Badge label={tr("m.settings.plan_badge", { plan: PLAN_LABEL[me.organization.plan] ?? me.organization.plan })} tone="brand" /> : null}
            {me?.user.twoFactor ? <Badge label={tr("m.settings.two_step_sign_in_on")} tone="ok" icon="shield" /> : null}
            {mode === "sample" ? <Badge label={tr("m.settings.sample_data")} tone="warn" /> : null}
          </View>
        </View>
      </Card>
      {/* MPAR2: account, plan (read only) and Get started are app screens now. */}
      <Row tile="orange" icon="user" label={tr("m.settings.name_and_password")} onPress={() => router.push("/account")} testID="account-link" />
      {me?.organization ? <Row tile="green" icon="dollar-sign" label={tr("m.billing.title")} value={PLAN_LABEL[me.organization.plan] ?? me.organization.plan} onPress={() => router.push("/billing")} testID="billing-link" /> : null}
      {checklistVisible(tours.data?.checklist) ? <Row tile="teal" icon="check-circle" label={tr("common.get_started")} value={tr("m.started.n_of_total_done", { done: tours.data!.checklist!.doneCount, total: tours.data!.checklist!.total })} onPress={() => router.push("/get-started")} testID="get-started-link" /> : null}

      <SectionTitle>{tr("m.settings.workspace")}</SectionTitle>
      <Row tile="indigo" icon="briefcase" label={tr("m.settings.workspace")} value={me?.organization?.name} onPress={() => router.push("/workspaces")} testID="workspaces-link" />
      <Row tile="blue" icon="filter" label={tr("m.settings.mail")} value={tr("m.settings.tabs_and_rules")} onPress={() => router.push("/mail-settings")} testID="mail-settings-link" />
      <Row tile="blue" icon="inbox" label={tr("m.settings.email_addresses")} value={overview.data ? String(overview.data.filter((m) => m.kind !== "agent").length) : undefined} onPress={() => router.push("/email-setup")} testID="email-setup-link" />
      <Row tile="purple" icon="cpu" label={tr("m.settings.agent_inboxes")} value={overview.data ? String(overview.data.filter((m) => m.kind === "agent").length) : undefined} />
      <Row tile="gray" icon="hard-drive" label={tr("m.settings.storage_used")} value={overview.data ? bytes(used) : undefined} />
      {me?.organization && webCfg.data && toolFeatureOn(webCfg.data, "merge_plus_r109") ? <Row tile="blue" icon="mail" label={tr("m.settings.mail_merge")} value={tr("m.settings.newsletters_and_journeys")} onPress={() => router.push("/mail-merge")} testID="mail-merge-link" /> : null}
      {me?.organization && flagOn(webCfg.data, "mailArchive") ? <Row tile="indigo" icon="archive" label={tr("m.settings.mail_archive")} value={tr("m.settings.retention_and_holds")} onPress={() => router.push("/mail-archive")} testID="mail-archive-link" /> : null}
      {me?.organization && flagOn(webCfg.data, "davSync") ? <Row tile="green" icon="calendar" label={tr("m.settings.calendar_and_contacts_sync")} onPress={() => router.push("/sync")} testID="sync-link" /> : null}
      <Row tile="gray" icon="external-link" label={tr("m.settings.team_and_domains")} onPress={() => open(WEB_PAGES.team)} />
      {/* M3 (1.10.11): features (Files, Tools, Social, Docs, Meetings, Portfolio, Contacts, People, Agent runs) live in More only, so Settings is settings. */}

      {/* M4: Lock Multies (Face ID, fingerprint or PIN) has its own screen. */}
      <SectionTitle>{tr("m.settings.security")}</SectionTitle>
      <Row tile="green" icon="lock" label={tr("m.settings.lock_multies")} value={lockOn ? tr("m.settings.on") : tr("m.settings.off")} onPress={() => router.push("/security")} testID="biometric-lock" />

      <SectionTitle>{tr("m.settings.notifications")}</SectionTitle>
      <Row tile="red" icon="inbox" label={tr("m.settings.notifications_inbox")} value={inbox.data ? `${inbox.data} unread` : undefined} onPress={() => router.push("/notifications")} testID="notifications-link" />
      <Row tile="red" icon="sliders" label={tr("m.settings.notification_settings")} onPress={() => router.push("/notification-settings")} testID="notification-settings-link" />
      <Row tile="red" icon="bell" label={allowed ? tr("m.settings.notifications_allowed") : tr("m.settings.turn_on_notifications")} value={allowed ? tr("m.settings.on") : undefined} onPress={turnOnPush} testID="push" />
      {push?.kind === "allowed" ? <Text style={[font.tiny, { marginHorizontal: space.lg }]}>{push.note}</Text> : null}
      {push?.kind === "unsupported" ? <Text style={[font.tiny, { marginHorizontal: space.lg }]}>{push.reason}</Text> : null}

      <SectionTitle>{tr("m.settings.this_phone")}</SectionTitle>
      {/* MPAR2: language and appearance are chosen here; each restarts the app so every screen follows. */}
      <Row tile="blue" icon="globe" label={tr("appearance.language")} value={savedChoice() === "system" ? tr("m.settings.phone_language_value", { lang: LANG_NAMES[currentLang()] }) : LANG_NAMES[currentLang()]} onPress={() => router.push("/language")} testID="language-link" />
      <Row tile="indigo" icon={scheme === "dark" ? "moon" : "sun"} label={tr("m.appearance.title")} value={[themeMode === "system" ? tr("m.appearance.match_phone") : tr(`theme.${themeMode}`), themeAccent === "forest" ? tr("m.appearance.forest") : null].filter(Boolean).join(", ")} onPress={() => router.push("/appearance")} testID="appearance-link" />
      <Row tile="gray" icon="download" label={tr("m.settings.clear_saved_mail")} onPress={clearCache} />
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm, gap: space.sm }} testID="undo-send-setting">
        <Text style={{ color: colors.fg, fontSize: 16 }} nativeID="undo-send-label">{tr("m.settings.undo_send")}</Text>
        <Segmented label={tr("m.settings.undo_send_window")} value={String(undoSeconds)} onChange={(v) => setUndoSeconds(parseUndoSeconds(v))}
          options={UNDO_SEND_CHOICES.map((n) => ({ id: String(n), label: `${n} s` }))} />
        <Text style={{ color: colors.subtle, fontSize: 13 }}>{tr("m.settings.how_long_you_have_to_take_a_message_back_after_s")}</Text>
      </View>

      <GestureSettings />

      <UpdateRows />

      <SectionTitle>{tr("m.settings.privacy_and_safety")}</SectionTitle>
      <Row tile="red" icon="user-x" label={tr("m.settings.blocked_people")} value={blockedCount ? String(blockedCount) : undefined} onPress={() => router.push("/blocked")} testID="blocked-link" />
      <Row tile="gray" icon="flag" label={tr("m.settings.community_rules")} onPress={() => open(LINKS.terms)} testID="community-rules" />
      <Text style={[font.tiny, { marginHorizontal: space.lg, marginTop: space.xs }]}>{tr("m.settings.to_report_a_message_press_and_hold_it_in_chat_ou")}</Text>

      <SectionTitle>{tr("m.settings.help_and_legal")}</SectionTitle>
      <Row tile="green" icon="activity" label={tr("m.settings.service_status")} onPress={() => open(LINKS.status)} />
      <Row tile="blue" icon="lock" label={tr("m.settings.privacy_policy")} onPress={() => open(LINKS.privacy)} />
      <Row tile="gray" icon="file-text" label={tr("m.settings.terms_of_service")} onPress={() => open(LINKS.terms)} />
      <Row tile="orange" icon="life-buoy" label={tr("m.settings.contact_support")} onPress={() => open(LINKS.support)} />

      <SectionTitle>{tr("m.settings.account")}</SectionTitle>
      <Row tile="gray" icon="log-out" label={mode === "sample" ? tr("m.settings.leave_the_sample_workspace") : tr("m.settings.sign_out_2")} onPress={confirmSignOut} testID="sign-out" />
      <Row icon="user-x" label={tr("m.settings.delete_my_account")} danger onPress={() => router.push("/delete-account")} testID="delete-account" />

      <Text style={[font.tiny, { textAlign: "center", marginTop: space.xl }]} testID="app-version">
        {versionLabel(version)}
      </Text>
      {updateDetail(version) ? (
        <Text style={[font.tiny, { textAlign: "center", marginTop: space.xs }]} testID="app-update">{updateDetail(version)}</Text>
      ) : null}
    </ScrollView>
    </View>
  );
}
