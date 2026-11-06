import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { ScreenHeader, ProgressBar, Problem } from "@/components/m3-ui";
import { Button, EmptyState, Icon, Loading } from "@/components/ui";
import { colors, font, lh, space, radius, TOUCH } from "@/theme";
import { tr } from "@/i18n";
import { FEATURES } from "@/config";
import { markOnOpen, stepTarget, stepText, type ChecklistStep } from "@/lib/mpar2";
import { useChecklistAction, useToursMe } from "@/lib/mpar2-queries";
import { openCommandSheet } from "@/lib/command-sheet-store";
import { openWeb } from "@/lib/web-open";
import { tick } from "@/lib/haptics";

/**
 * MPAR2: Get started, the web's checklist (GET /api/tours/me) on the phone. Each step opens its app screen when the app
 * has one, the command sheet for the keyboard step, else the web page in the in-app browser. Steps that are done by
 * opening them are ticked on the server (POST /api/tours/checklist), the rest tick themselves once done.
 */
export default function GetStarted() {
  const q = useToursMe();
  const act = useChecklistAction();
  const c = q.data?.checklist ?? null;
  const open = (s: ChecklistStep) => {
    tick();
    if (!s.done && markOnOpen(s)) act.mutate({ action: "mark", step: String(s.id) });
    const t = stepTarget(s, { tasks: FEATURES.tasks });
    if (t.kind === "command") { router.back(); setTimeout(() => openCommandSheet(), 250); return; }
    if (t.kind === "screen") { router.push(t.href as never); return; }
    void openWeb(t.path);
  };
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="get-started-screen">
      <ScreenHeader title={tr("common.get_started")} back={tr("common.back")} />
      {q.isLoading ? <Loading label={tr("m.started.loading")} rows={5} variant="task" /> : q.error && !q.data ? <Problem q={q} what={tr("common.get_started")} testID="started-problem" /> :
        !q.data?.enabled || !c ? <EmptyState icon="check-circle" title={tr("m.started.off_title")} body={tr("m.started.off_body")} /> : (
        <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl, gap: space.md }} refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { void q.refetch(); }} />}>
          <View style={st.head}>
            <Text style={font.small} testID="started-count">{tr("m.started.n_of_total_done", { done: c.doneCount, total: c.total })}</Text>
            <ProgressBar value={c.total ? (c.doneCount / c.total) * 100 : 0} tone={c.complete ? "ok" : "brand"} label={tr("m.started.progress", { done: c.doneCount, total: c.total })} />
          </View>
          {c.complete ? (
            <View style={st.done} testID="started-complete">
              <Text style={font.headline}>{tr("m.started.all_set")}</Text>
              <Text style={font.small}>{tr("m.started.all_set_body")}</Text>
              {!c.celebrated ? <Button label={tr("common.done")} variant="secondary" onPress={() => { act.mutate({ action: "celebrated" }); router.back(); }} testID="started-celebrated" /> : null}
            </View>
          ) : null}
          <View style={st.list}>
            {c.steps.map((s, i) => {
              const tx = stepText(s);
              return (
                <Pressable key={String(s.id)} onPress={() => open(s)} accessibilityRole="button" accessibilityState={{ checked: s.done }}
                  accessibilityLabel={`${tx.title}. ${tx.body}${s.done ? `. ${tr("m.started.done")}` : ""}`} testID={`started-${s.id}`}
                  style={({ pressed }) => [st.row, i > 0 && st.rowLine, pressed && { backgroundColor: colors.hover }]}>
                  <View style={[st.dot, s.done ? { backgroundColor: colors.ok, borderColor: colors.ok } : { borderColor: colors.lineStrong }]}>
                    {s.done ? <Icon name="check" size={14} color="#FFFFFF" /> : null}
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={[st.title, s.done && { color: colors.muted, textDecorationLine: "line-through" }]}>{tx.title}</Text>
                    <Text style={st.body}>{tx.body}</Text>
                  </View>
                  <Icon name="chevron-right" size={18} color={colors.subtle} />
                </Pressable>
              );
            })}
          </View>
          {!c.complete ? <Button label={tr("m.started.hide")} variant="ghost" onPress={() => { act.mutate({ action: "dismiss" }); router.back(); }} testID="started-hide" /> : null}
          <Text style={[font.tiny, { textAlign: "center" }]}>{tr("m.started.hide_note")}</Text>
        </ScrollView>
      )}
    </View>
  );
}
const st = StyleSheet.create({
  head: { gap: space.sm },
  done: { backgroundColor: colors.okSoft, borderRadius: radius.lg, padding: space.lg, gap: space.sm },
  list: { backgroundColor: colors.surface, borderRadius: 14, overflow: "hidden" },
  row: { minHeight: Math.max(TOUCH, 64), flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md },
  rowLine: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  dot: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  title: { color: colors.fg, fontSize: 17, fontWeight: "600", lineHeight: lh(22) },
  body: { color: colors.muted, fontSize: 15, lineHeight: lh(20) },
});
