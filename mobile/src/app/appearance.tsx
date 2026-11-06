import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { ScreenHeader } from "@/components/m3-ui";
import { InsetGroup } from "@/components/grouped";
import { Choice } from "@/components/choice";
import { Icon } from "@/components/ui";
import { accent as startAccent, mode as startMode, paletteFor, resolveScheme, saveAppearance, colors, font, lh, space, radius, type Accent, type AppearanceMode } from "@/theme";
import { Appearance } from "react-native";
import { reloadApp } from "@/lib/app-reload";
import { tick } from "@/lib/haptics";
import { tr } from "@/i18n";

/**
 * MPAR2: Settings > Appearance. Mode (follow the phone, light or dark) and the accent (Multies blue or the web's
 * Forest green). The colours are chosen when the app starts, so a change restarts the app at once.
 */
export default function AppearanceScreen() {
  const [m, setM] = useState<AppearanceMode>(startMode);
  const [a, setA] = useState<Accent>(startAccent);
  const [note, setNote] = useState<string | null>(null);
  const apply = async (nm: AppearanceMode, na: Accent) => {
    tick();
    setM(nm); setA(na);
    saveAppearance(nm, na);
    if (nm === startMode && na === startAccent) { setNote(null); return; }
    const ok = await reloadApp();
    if (!ok) setNote(tr("m.appearance.shows_next_open"));
  };
  const modes: { id: AppearanceMode; label: string; icon: "smartphone" | "sun" | "moon" }[] = [
    { id: "system", label: tr("m.appearance.match_phone"), icon: "smartphone" },
    { id: "light", label: tr("theme.light"), icon: "sun" },
    { id: "dark", label: tr("theme.dark"), icon: "moon" },
  ];
  const accents: { id: Accent; label: string }[] = [
    { id: "blue", label: tr("m.appearance.multies_blue") },
    { id: "forest", label: tr("m.appearance.forest") },
  ];
  const scheme = resolveScheme(m, Appearance.getColorScheme());
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="appearance-screen">
      <ScreenHeader title={tr("m.appearance.title")} back={tr("nav.settings")} />
      <ScrollView contentContainerStyle={{ paddingBottom: space.xxl }}>
        <InsetGroup header={tr("m.appearance.mode")} footer={tr("m.appearance.mode_hint")}>
          {modes.map((o) => (
            <Choice key={o.id} label={o.label} selected={m === o.id} onPress={() => apply(o.id, a)} testID={`appearance-${o.id}`} left={<Icon name={o.icon} size={20} color={colors.brand} />} />
          ))}
        </InsetGroup>
        <InsetGroup header={tr("m.appearance.accent")} footer={tr("m.appearance.accent_hint")}>
          {accents.map((o) => (
            <Choice key={o.id} label={o.label} selected={a === o.id} onPress={() => apply(m, o.id)} testID={`accent-${o.id}`}
              left={<View style={[st.swatch, { backgroundColor: paletteFor(scheme, o.id).brandFill }]} />} />
          ))}
        </InsetGroup>
        <Preview mode={m} accent={a} />
        {note ? <Text style={st.note} accessibilityLiveRegion="polite" testID="appearance-note">{note}</Text> : null}
      </ScrollView>
    </View>
  );
}

/** A small picture of a screen in the picked colours (what the app looks like after the restart). */
function Preview({ mode, accent }: { mode: AppearanceMode; accent: Accent }) {
  const p = paletteFor(resolveScheme(mode, Appearance.getColorScheme()), accent);
  return (
    <View style={[st.preview, { backgroundColor: p.bg, borderColor: p.lineStrong }]} accessible accessibilityLabel={tr("m.appearance.preview")} testID="appearance-preview">
      <View style={[st.previewCard, { backgroundColor: p.surface }]}>
        <Text style={{ color: p.fg, fontSize: 15, fontWeight: "600", lineHeight: lh(20) }}>{tr("m.appearance.preview_title")}</Text>
        <Text style={{ color: p.muted, fontSize: 13, lineHeight: lh(18) }}>{tr("m.appearance.preview_body")}</Text>
        <View style={[st.previewButton, { backgroundColor: p.brandFill }]}><Text style={{ color: p.brandFg, fontSize: 13, fontWeight: "600", lineHeight: lh(18) }}>{tr("m.appearance.preview_button")}</Text></View>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  swatch: { width: 22, height: 22, borderRadius: 11 },
  preview: { marginHorizontal: space.lg, marginTop: space.xl, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: space.md },
  previewCard: { borderRadius: radius.md, padding: space.md, gap: 6 },
  previewButton: { alignSelf: "flex-start", borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 6, marginTop: 4 },
  note: { ...font.small, marginHorizontal: space.lg, marginTop: space.lg },
});
