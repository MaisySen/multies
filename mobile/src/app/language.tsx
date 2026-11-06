import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { ScreenHeader } from "@/components/m3-ui";
import { InsetGroup } from "@/components/grouped";
import { Choice } from "@/components/choice";
import { colors, font, space } from "@/theme";
import { LANG_NAMES, currentLang, deviceLang, saveLanguageChoice, savedChoice, tr, type LangChoice } from "@/i18n";
import { reloadApp } from "@/lib/app-reload";
import { accountLocale } from "@/lib/mpar2";
import { useSavePreferences } from "@/lib/mpar2-queries";
import { useSession } from "@/lib/session";
import { tick } from "@/lib/haptics";

/**
 * MPAR2: Settings > Language. Follows the phone by default; English, Nepali or Hindi can be picked. The choice is kept
 * on this phone and, when signed in, saved on the account too so the web app uses the same language. Words are chosen
 * when the app starts, so a change restarts the app at once.
 */
export default function LanguageScreen() {
  const { mode } = useSession();
  const save = useSavePreferences();
  const [choice, setChoice] = useState<LangChoice>(savedChoice());
  const [note, setNote] = useState<string | null>(null);
  const phone = deviceLang();
  const pick = async (c: LangChoice) => {
    tick();
    setChoice(c);
    const lang = saveLanguageChoice(c);
    if (mode === "live") { try { await save.mutateAsync({ locale: accountLocale(lang) }); } catch { /* kept on this phone; the web keeps its own */ } }
    if (lang === currentLang()) { setNote(null); return; }
    const ok = await reloadApp();
    if (!ok) setNote(tr("m.language.shows_next_open"));
  };
  const options: { id: LangChoice; label: string; sub?: string }[] = [
    { id: "system", label: tr("m.language.phone_language"), sub: LANG_NAMES[phone] },
    { id: "en", label: LANG_NAMES.en },
    { id: "ne", label: LANG_NAMES.ne, sub: "Nepali" },
    { id: "hi", label: LANG_NAMES.hi, sub: "Hindi" },
  ];
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="language-screen">
      <ScreenHeader title={tr("appearance.language")} back={tr("nav.settings")} />
      <ScrollView contentContainerStyle={{ paddingBottom: space.xxl }}>
        <InsetGroup footer={tr("m.language.hint")}>
          {options.map((o) => <Choice key={o.id} label={o.label} sub={o.sub} selected={choice === o.id} onPress={() => pick(o.id)} testID={`language-${o.id}`} />)}
        </InsetGroup>
        {currentLang() !== "en" ? <Text style={st.note}>{tr("m.language.draft_note")}</Text> : null}
        {note ? <Text style={st.note} accessibilityLiveRegion="polite" testID="language-note">{note}</Text> : null}
      </ScrollView>
    </View>
  );
}
const st = StyleSheet.create({ note: { ...font.small, marginHorizontal: space.lg, marginTop: space.lg } });
