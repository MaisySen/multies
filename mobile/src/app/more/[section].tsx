/**
 * M3 (1.10.11): app screens first, web only pages grouped at the end (no "All of" row).
 * M2 (1.10.10): one section of More: the pages the server lists for this person (web R121 menu), each in its app
 * screen where one exists, else the web page in the in-app browser, signed in. Settings adds the web's Mail setup
 * pages. The section's own web home is always the last row, so everything the web has under it stays one tap away.
 */
import { ScrollView, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { ScreenHeader } from "@/components/m3-ui";
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
import { tl, tr } from "@/i18n";

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

  if (q.isPending) return <View style={{ flex: 1, backgroundColor: colors.bg }}><ScreenHeader title="More" back="More" /><Loading label="Loading" rows={5} /></View>;
  if (!s) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }} testID="more-section-missing">
        <ScreenHeader title="More" back="More" />
        <EmptyState icon="layers" title="This section isn't here" body="It may be off for your workspace or your role."
          action={<Button label="Retry" onPress={() => q.refetch()} testID="more-section-retry" />} />
      </View>
    );
  }
  // M3 (1.10.11): pages with an app screen first; pages that only exist on the web sit in their own group at the end,
  // said plainly, and open inside the app with a Done button. No "All of" row: everything the section has is listed.
  const mailSetup = s.id === "workspace" ? (q.data?.menu.mailSetup ?? []).map((m) => ({ to: m.to, label: m.label, icon: m.label === "Routing" ? "automations" : m.label.toLowerCase() })) : [];
  const all = [...s.pages, ...mailSetup.filter((m) => !s.pages.some((p) => p.to === m.to))];
  const isNative = (to: string) => !!nativeRoute(to, { tasks: FEATURES.tasks });
  const native = all.filter((p) => isNative(p.to));
  const webOnly = all.filter((p) => !isNative(p.to));
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID={`more-section-${s.id}`}>
      <ScreenHeader title={tl("nav", s.label)} back={tr("nav.more")} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: insets.bottom + space.xl }}>
        {native.length ? (
          <InsetGroup>
            {native.map((p) => {
              const n = countOf(live, (p as { count?: string }).count);
              return (
                <GroupRow key={p.to} testID={`more-page-${p.to}`} label={tl("nav", p.label)} icon={iconFor(p.icon)} tile={colorFor(s.id)}
                  value={n > 0 ? countText(n) : null} chevron onPress={() => openPage(p.to, transport)} />
              );
            })}
          </InsetGroup>
        ) : null}
        {webOnly.length ? (
          <InsetGroup header="On the web" footer="These open inside the app, already signed in. Tap Done to come back." testID="more-web-group">
            {webOnly.map((p) => (
              <GroupRow key={p.to} testID={`more-page-${p.to}`} label={tl("nav", p.label)} icon={iconFor(p.icon)} tile="gray" right={web} chevron={false}
                hint="Opens inside the app" onPress={() => openPage(p.to, transport)} />
            ))}
          </InsetGroup>
        ) : null}
      </ScrollView>
    </View>
  );
}
