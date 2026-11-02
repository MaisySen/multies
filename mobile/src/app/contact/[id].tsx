/**
 * M1 (1.10.9): one contact, as on the web: name, company, email (opens a new message), phone (tap to call) and, when maps
 * are on, the saved address with Get directions in Apple Maps on iPhone or Google Maps on Android.
 */
import { Alert, Linking, Platform, RefreshControl, ScrollView, Text, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Avatar, Button, EmptyState, Loading } from "@/components/ui";
import { GroupRow, InsetGroup } from "@/components/grouped";
import { LoadError, NoAccess } from "@/components/m1-work";
import { noAccess, notFoundErr, useContact, usePlace } from "@/lib/contacts-queries";
import { contactName, directionsUrl, mapsAppFor, MAPS_APP_NAME, telUrl } from "@/lib/contacts";
import { flagOn, useWebConfig } from "@/lib/web-config";
import { colors, font, space } from "@/theme";

async function openUrl(url: string, what: string) {
  try { await Linking.openURL(url); } catch { Alert.alert(`Couldn't open ${what}`, "Check that the app is installed on this phone."); }
}

export default function ContactScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useContact(id);
  const cfg = useWebConfig();
  const maps = flagOn(cfg.data, "maps");
  const place = usePlace("contact", q.data?.contact.id, maps);
  const app = mapsAppFor(Platform.OS);

  const header = <Stack.Screen options={{ title: q.data ? contactName(q.data.contact) : "Contact" }} />;
  if (noAccess(q.error)) return <>{header}<NoAccess what="Contacts" /></>;
  if (q.isPending) return <>{header}<Loading label="Loading contact" rows={4} /></>;
  if (notFoundErr(q.error)) return <>{header}<EmptyState icon="user-x" title="Contact not found" body="It may have been deleted, or it belongs to another workspace." art={null} /></>;
  if (q.error || !q.data) return <>{header}<LoadError title="Couldn't load this contact" error={q.error} onRetry={() => q.refetch()} /></>;

  const c = q.data.contact;
  const tel = telUrl(c.phone);
  const p = place.data;

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: space.xxl, gap: space.lg }}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); place.refetch(); }} />} testID="contact-detail">
      {header}
      <View style={{ alignItems: "center", gap: space.xs, paddingTop: space.xl, paddingHorizontal: space.lg }}>
        <Avatar name={contactName(c)} size={72} />
        <Text style={[font.heading, { textAlign: "center" }]} accessibilityRole="header" testID="contact-name">{contactName(c)}</Text>
        {c.title || c.company ? <Text style={[font.small, { textAlign: "center" }]}>{[c.title, c.company?.name].filter(Boolean).join(", ")}</Text> : null}
      </View>

      <InsetGroup>
        <GroupRow icon="mail" tile="blue" label="Email" sub={c.email} onPress={() => router.push({ pathname: "/compose", params: { to: c.email } })} hint="Starts a new message" testID="contact-email" />
        {c.phone ? (
          <GroupRow icon="smartphone" tile="green" label="Phone" sub={c.phone} onPress={tel ? () => openUrl(tel, "the phone app") : undefined} hint="Calls this number" testID="contact-phone" />
        ) : <GroupRow icon="smartphone" tile="gray" label="Phone" sub="No phone number saved" testID="contact-phone-none" />}
        {c.company ? <GroupRow icon="briefcase" tile="orange" label="Company" sub={c.company.name} testID="contact-company" /> : null}
      </InsetGroup>

      {maps ? (
        <InsetGroup header="Address" footer={p ? undefined : "Add or change an address on the web, on this contact."} testID="contact-address">
          {place.isPending ? <GroupRow icon="map-pin" label="Loading address" /> : p ? (
            <View>
              <GroupRow icon="map-pin" tile="red" label={p.address} testID="contact-address-text" />
              <View style={{ padding: space.md }}>
                <Button label="Get directions" icon="compass" onPress={() => openUrl(directionsUrl(p, app), MAPS_APP_NAME[app])}
                  accessibilityHint={`Opens ${MAPS_APP_NAME[app]} with directions`} testID="contact-directions" />
              </View>
            </View>
          ) : <GroupRow icon="map-pin" tile="gray" label="No address saved" testID="contact-address-none" />}
        </InsetGroup>
      ) : null}

      {c.notes ? (
        <InsetGroup header="Notes">
          <Text style={{ color: colors.fg, fontSize: 16, lineHeight: 22, padding: space.lg }} selectable testID="contact-notes">{c.notes}</Text>
        </InsetGroup>
      ) : null}
    </ScrollView>
  );
}
