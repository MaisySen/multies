import type { ReactNode } from "react";
import { Alert, Platform, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Badge, Banner, Button, Icon, type IconName } from "@/components/ui";
import { useConnectionActions, useConnections, useFreeAddress, useOverview } from "@/lib/queries";
import { connectionStatusLabel, connectionTone, lastSyncLabel, type ConnectionView } from "@/lib/mail-connect";
import { WEB_PAGES } from "@/config";
import { colors, font, radius, space } from "@/theme";

/**
 * Email addresses: the three ways to get one (connect an existing mailbox, a free address on the
 * Multies shared domain, or your own domain on the web), and the mailboxes already connected.
 */
export default function EmailSetup() {
  const overview = useOverview();
  const conns = useConnections();
  const free = useFreeAddress();
  const mailboxes = overview.data?.filter((m) => m.kind !== "agent") ?? [];
  const connections = conns.data?.connections ?? [];
  const f = free.data;
  const mine = f && f.enabled ? f.addresses[0] : undefined;
  const refreshing = conns.isRefetching || free.isRefetching || overview.isRefetching;
  const refresh = () => { void conns.refetch(); void free.refetch(); void overview.refetch(); };
  const connectOff = conns.data ? !conns.data.enabled : false;

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentInsetAdjustmentBehavior="automatic" testID="email-setup"
      contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.xxl * 2 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
      <Text style={font.small}>
        {mailboxes.length
          ? `You can send from ${mailboxes.length === 1 ? mailboxes[0].address : `${mailboxes.length} addresses`}. Add another any time.`
          : "Add an email address to send and receive mail in Multies. Pick one way below."}
      </Text>

      <Option icon="link" title="Connect your email" testID="option-connect"
        body="Gmail, Outlook, iCloud, Yahoo, Zoho or any other mailbox. Your mail syncs here and you send as that address."
        onPress={() => (connectOff ? WebBrowser.openBrowserAsync(WEB_PAGES.connections) : router.push("/connect-mailbox"))} />

      {f && f.enabled && (mine || f.available) ? (
        <Option icon="at-sign" testID="option-free"
          title={mine ? "Your free address" : `Get a free @${f.domain} address`}
          body={mine ? mine.address : "Your own personal address, free. Send and receive straight away. One per person."}
          done={!!mine}
          onPress={() => router.push("/free-address")} />
      ) : null}

      <Option icon="globe" title="Use your own domain" testID="option-domain"
        body="Mail on your business name, like you@yourcompany.com. Set up on the web, where you add the DNS records."
        external onPress={() => WebBrowser.openBrowserAsync(WEB_PAGES.domains)} />

      {connections.length ? (
        <View style={{ gap: space.sm, marginTop: space.md }}>
          <Text style={[font.tiny, { textTransform: "uppercase", letterSpacing: 0.6 }]} accessibilityRole="header">Connected accounts</Text>
          {connections.map((c) => <ConnectionCard key={c.id} c={c} />)}
        </View>
      ) : null}
      {conns.error ? <Banner tone="bad" icon="alert-circle" text={`Couldn't load connected accounts. ${conns.error.message}`} /> : null}
    </ScrollView>
  );
}

function Option({ icon, title, body, onPress, done, external, testID }: {
  icon: IconName; title: string; body: string; onPress: () => void; done?: boolean; external?: boolean; testID?: string;
}) {
  return (
    <View style={{ backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, overflow: "hidden" }}>
      <PressRow onPress={onPress} testID={testID} label={`${title}. ${body}`}>
        <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: done ? colors.okSoft : colors.brandSoft }}>
          <Icon name={done ? "check" : icon} size={18} color={done ? colors.ok : colors.brand} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[font.heading, { fontSize: 16 }]}>{title}</Text>
          <Text style={font.small}>{body}</Text>
        </View>
        <Icon name={external ? "external-link" : "chevron-right"} size={18} color={colors.subtle} />
      </PressRow>
    </View>
  );
}

function PressRow({ children, onPress, testID, label }: { children: ReactNode; onPress: () => void; testID?: string; label: string }) {
  return (
    <Pressable onPress={onPress} testID={testID} accessibilityRole="button" accessibilityLabel={label}
      style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: space.md, padding: space.lg, minHeight: 64 }, pressed && { backgroundColor: colors.hover }]}>
      {children}
    </Pressable>
  );
}

function ConnectionCard({ c }: { c: ConnectionView }) {
  const { sync, remove } = useConnectionActions();
  const busy = (sync.isPending && sync.variables === c.id) || (remove.isPending && remove.variables === c.id);
  const confirmRemove = () => {
    const go = () => remove.mutate(c.id, { onError: (e) => Alert.alert("Couldn't remove", (e as Error).message) });
    if (Platform.OS === "web") return go();
    Alert.alert(`Remove ${c.email}?`, "Multies stops syncing it and deletes the stored password. Mail already synced stays in the workspace.", [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: go },
    ]);
  };
  const syncNow = () => sync.mutate(c.id, {
    onSuccess: (r) => { if (r.result.error) Alert.alert("Sync stopped", r.result.error); },
    onError: (e) => Alert.alert("Couldn't sync", (e as Error).message),
  });
  return (
    <View testID={`connection-${c.id}`} style={{ backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.lg, gap: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Icon name="mail" size={18} color={colors.muted} />
        <Text style={[font.heading, { fontSize: 16, flex: 1 }]} numberOfLines={1}>{c.email}</Text>
        <Badge label={connectionStatusLabel(c.status)} tone={connectionTone(c.status)} />
      </View>
      <Text style={font.small}>{c.providerLabel}. {lastSyncLabel(c.lastSyncAt)}{c.messagesSynced ? `, ${c.messagesSynced} messages` : ""}.</Text>
      {c.lastError ? <Text style={{ color: c.status === "auth_failed" ? colors.warn : colors.bad, fontSize: 14 }}>{c.lastError}</Text> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        {c.status === "auth_failed" ? (
          <Button label="Reconnect" icon="key" variant="secondary" testID={`reconnect-${c.id}`} disabled={busy}
            onPress={() => router.push({ pathname: "/connect-mailbox", params: { reconnect: c.id, email: c.email, preset: c.provider } })} style={{ minHeight: 36 }} />
        ) : (
          <Button label="Sync now" icon="refresh-cw" variant="secondary" testID={`sync-${c.id}`} loading={sync.isPending && sync.variables === c.id} disabled={busy} onPress={syncNow} style={{ minHeight: 36 }} />
        )}
        <Button label="Remove" icon="trash-2" variant="ghost" testID={`remove-${c.id}`} loading={remove.isPending && remove.variables === c.id} disabled={busy} onPress={confirmRemove} style={{ minHeight: 36 }} />
      </View>
    </View>
  );
}
