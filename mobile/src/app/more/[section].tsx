/**
 * M2 (1.10.10): one section of More: the pages the server lists for this person (web R121 menu), each in its app
 * screen where one exists, else the web page in the in-app browser, signed in. Settings adds the web's Mail setup
 * pages. The section's own web home is always the last row, so everything the web has under it stays one tap away.
 */
import { ScrollView, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GroupRow, InsetGroup } from "@/components/grouped";
import { Button, EmptyState, Icon, Loading } from "@/components/ui";
import { useCounts } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { useNavMenu } from "@/lib/nav-menu-queries";
import { colorFor, countOf, countText, iconFor, nativeRoute, sectionExtras } from "@/lib/nav-menu";
import { useWebConfig } from "@/lib/web-config";
import { openWebPage } from "@/lib/web-open";
import { FEATURES } from "@/config";
import { colors, space } from "@/theme";

export function openPage(to: string, transport: Parameters<typeof openWebPage>[0]) {
  const native = nativeRoute(to, { tasks: FEATURES.tasks });
  if (native) router.push(native as never);
  else openWebPage(transport, to).catch(() => {});
}

export default function MoreSection() {
  const { section } = useLocalSearchParams<{ section: string }>();
  const insets = useSafeAreaInsets();
  const { transport } = useSession();
  const q = useNavMenu();
  const counts = useCounts();
  const cfg = useWebConfig();
  const found = q.data?.menu.sections.find((x) => x.id === section);
  const s = found ? { ...found, pages: [...found.pages, ...sectionExtras(found.id, cfg.data as Record<string, unknown> | undefined, found.pages.map((p) => p.to))] } : undefined;
  const live = q.data?.problem === "offline" ? null : counts.data;
  const web = <View style={{ flexDirection: "row", alignItems: "center" }}><Icon name="external-link" size={15} color={colors.subtle} /></View>;

  if (q.isPending) return <View style={{ flex: 1, backgroundColor: colors.bg }}><Stack.Screen options={{ title: "" }} /><Loading label="Loading" rows={5} /></View>;
  if (!s) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }} testID="more-section-missing">
        <Stack.Screen options={{ title: "" }} />
        <EmptyState icon="layers" title="This section isn't here" body="It may be off for your workspace or your role."
          action={<Button label="Retry" onPress={() => q.refetch()} testID="more-section-retry" />} />
      </View>
    );
  }
  const hasHome = s.pages.some((p) => p.to === s.to);
  const mailSetup = s.id === "workspace" ? q.data?.menu.mailSetup ?? [] : [];
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID={`more-section-${s.id}`}>
      <Stack.Screen options={{ title: s.label }} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: insets.bottom + space.xl }}>
        <InsetGroup>
          {s.pages.map((p) => {
            const n = countOf(live, p.count);
            const native = !!nativeRoute(p.to, { tasks: FEATURES.tasks });
            return (
              <GroupRow key={p.to} testID={`more-page-${p.to}`} label={p.label} icon={iconFor(p.icon)} tile={colorFor(s.id)}
                value={n > 0 ? countText(n) : null} right={native ? undefined : web} chevron={native}
                hint={native ? undefined : "Opens the web page"} onPress={() => openPage(p.to, transport)} />
            );
          })}
        </InsetGroup>
        {mailSetup.length ? (
          <InsetGroup header="Mail setup">
            {mailSetup.map((m) => (
              <GroupRow key={m.to} testID={`more-page-${m.to}`} label={m.label} icon={iconFor(m.label === "Routing" ? "automations" : m.label.toLowerCase())}
                tile="gray" right={web} chevron={false} hint="Opens the web page" onPress={() => openPage(m.to, transport)} />
            ))}
          </InsetGroup>
        ) : null}
        {!hasHome ? (
          <InsetGroup footer="Everything in this section, as on the web.">
            <GroupRow testID="more-section-web" label={`All of ${s.label}`} icon="globe" tile="gray" right={web} chevron={false}
              hint="Opens the web page" onPress={() => openWebPage(transport, s.to).catch(() => {})} />
          </InsetGroup>
        ) : null}
      </ScrollView>
    </View>
  );
}
