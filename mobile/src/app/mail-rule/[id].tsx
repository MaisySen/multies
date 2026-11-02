import { useEffect, useState } from "react";
import { Pressable, ScrollView, Switch, Text, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Banner, Button, Chip, EmptyState, Field, Icon, IconButton, Loading, Segmented } from "@/components/ui";
import { ActionSheet } from "@/components/action-sheet";
import { ConfirmSheet } from "@/components/social";
import { useInboxTabs, useMailMutations, useMailRule, useMailRuleRuns } from "@/lib/mail-queries";
import { useOverview } from "@/lib/queries";
import { useOffline } from "@/lib/offline";
import { WEB_PAGES } from "@/config";
import {
  ACTION_LABEL, checkDraft, describeAction, describeConditions, draftOf, draftOk, emptyDraft, fieldLabel, fieldNeedsValue, newAction, PHONE_ACTIONS,
  phoneEditable, RULE_ACTIONS_MAX, RULE_CONDITIONS_MAX, RULE_FIELDS, runProblem, sendsMail, toInput,
  type DraftProblems, type MailRule, type RuleAction, type RuleDraft, type RuleField, type RuleTestResult,
} from "@/lib/mail-rules";
import { shortDate } from "@/lib/format";
import { success, tick, warning } from "@/lib/haptics";
import { showQuickToast } from "@/lib/quick-actions";
import { colors, font, radius, space, TOUCH } from "@/theme";
import { openWeb } from "@/lib/web-open";

/** 1.10.7: one mail rule (what it does, its recent runs, Run on recent mail, Edit, Delete) or the form for a new one. */
export default function MailRuleScreen() {
  const { id = "" } = useLocalSearchParams<{ id: string }>();
  const isNew = id === "new";
  const rule = useMailRule(id);
  const [editing, setEditing] = useState(isNew);
  if (isNew || editing) return <RuleForm rule={isNew ? undefined : rule.data} onDone={() => (isNew ? router.back() : setEditing(false))} />;
  if (rule.isPending) return <View style={{ flex: 1, backgroundColor: colors.bg }}><Stack.Screen options={{ title: "Rule" }} /><Loading rows={4} label="Loading the rule" /></View>;
  if (rule.error || !rule.data) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <Stack.Screen options={{ title: "Rule" }} />
        <EmptyState icon="alert-circle" title="Couldn't load this rule" body="It may have been deleted on the web." action={<Button label="Try again" variant="secondary" onPress={() => rule.refetch()} />} />
      </View>
    );
  }
  return <RuleDetail rule={rule.data} onEdit={() => setEditing(true)} />;
}

function Section({ title, children, testID }: { title: string; children: React.ReactNode; testID?: string }) {
  return (
    <View style={{ marginHorizontal: space.lg, marginTop: space.lg, gap: space.sm }} testID={testID}>
      <Text style={{ color: colors.subtle, fontSize: 13, fontWeight: "600" }} accessibilityRole="header">{title}</Text>
      <View style={{ backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg, gap: space.md }}>{children}</View>
    </View>
  );
}

function Line({ icon, text }: { icon: "filter" | "zap" | "alert-circle" | "check"; text: string }) {
  return (
    <View style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-start" }}>
      <View style={{ paddingTop: 2 }}><Icon name={icon} size={16} color={icon === "alert-circle" ? colors.bad : colors.brand} /></View>
      <Text style={{ flex: 1, color: colors.fg, fontSize: 15, lineHeight: 21 }}>{text}</Text>
    </View>
  );
}

function RuleDetail({ rule, onEdit }: { rule: MailRule; onEdit: () => void }) {
  const runs = useMailRuleRuns(rule.id);
  const tabs = useInboxTabs();
  const mm = useMailMutations();
  const offline = useOffline();
  const [confirm, setConfirm] = useState(false);
  const tabName = (t: string) => tabs.data?.tabs.find((x) => x.id === t)?.name;
  const web = sendsMail(rule) || !phoneEditable(rule);
  const toggle = (enabled: boolean) => mm.updateRule.mutate({ id: rule.id, patch: { enabled } }, { onError: () => { warning(); showQuickToast("Couldn't change the rule", "bad"); } });
  const runNow = () => mm.runRecent.mutate(rule.id, {
    onSuccess: (r) => { success(); showQuickToast(r.ran ? `Ran on ${r.ran} ${r.ran === 1 ? "email" : "emails"}` : "No recent mail matches"); },
    onError: () => { warning(); showQuickToast("Couldn't run the rule", "bad"); },
  });
  const remove = () => mm.deleteRule.mutate(rule.id, {
    onSuccess: () => { success(); setConfirm(false); showQuickToast("Rule deleted"); router.back(); },
    onError: () => { warning(); setConfirm(false); showQuickToast("Couldn't delete the rule", "bad"); },
  });
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: "Rule", headerRight: () => (!web ? <IconButton icon="edit-3" label="Edit rule" onPress={onEdit} testID="rule-edit-top" /> : null) }} />
      <ScrollView contentContainerStyle={{ paddingBottom: 48 }} testID="rule-detail">
        {offline ? <Banner text="You're offline. Showing the rule saved on this phone." /> : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingTop: space.lg }}>
          <Text style={[font.title, { flex: 1, fontSize: 24 }]} accessibilityRole="header" selectable>{rule.name}</Text>
          <Switch value={mm.updateRule.isPending && mm.updateRule.variables?.patch.enabled !== undefined ? !!mm.updateRule.variables.patch.enabled : rule.enabled}
            onValueChange={(v) => { tick(); toggle(v); }} disabled={offline} accessibilityLabel={`${rule.name}, ${rule.enabled ? "on" : "off"}`} testID="rule-switch"
            trackColor={{ true: colors.ok, false: colors.elevated }} />
        </View>
        <Text style={{ color: colors.subtle, fontSize: 14, paddingHorizontal: space.lg, marginTop: 4 }}>
          {rule.runCount ? `Ran ${rule.runCount} ${rule.runCount === 1 ? "time" : "times"}${rule.lastRunAt ? `, last ${shortDate(rule.lastRunAt)}` : ""}` : "Hasn't run yet"}
        </Text>
        {web ? (
          <View style={{ marginHorizontal: space.lg, marginTop: space.md, padding: space.md, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.brandLine, gap: space.sm }} testID="rule-web-only">
            <Text style={{ color: colors.fg, fontSize: 14, lineHeight: 20 }}>This rule sends mail to other people, so it is changed on the web. Here you can turn it on or off, or delete it.</Text>
            <Pressable onPress={() => { tick(); void openWeb(WEB_PAGES.mailRules); }} accessibilityRole="link" testID="rule-open-web" style={{ minHeight: 32, justifyContent: "center" }}>
              <Text style={{ color: colors.brand, fontWeight: "600", fontSize: 15 }}>Change it on the web</Text>
            </Pressable>
          </View>
        ) : null}
        {rule.lastError ? <View style={{ marginHorizontal: space.lg, marginTop: space.md }}><Line icon="alert-circle" text={`Last problem: ${rule.lastError}`} /></View> : null}
        <Section title="When new mail" testID="rule-when">
          <Line icon="filter" text={`${describeConditions(rule)}${rule.conditions.length > 1 ? (rule.match === "any" ? " (any one)" : " (all of them)") : ""}`} />
        </Section>
        <Section title="Then, in order" testID="rule-then">
          {rule.actions.map((a, i) => <Line key={i} icon="zap" text={`${i + 1}. ${describeAction(a, tabName)}`} />)}
        </Section>
        <Section title="Recent runs" testID="rule-runs">
          {runs.isPending ? <Loading rows={2} label="Loading runs" /> : runs.error && !runs.data ? (
            <Text style={{ color: colors.muted, fontSize: 15 }}>{"Couldn't load the runs."}</Text>
          ) : !runs.data?.length ? (
            <Text style={{ color: colors.muted, fontSize: 15 }}>No runs yet. It runs when new mail matches.</Text>
          ) : runs.data.slice(0, 10).map((r) => {
            const problem = runProblem(r);
            return (
              <View key={r.id} style={{ gap: 2 }} accessible accessibilityLabel={`${r.subject ?? "No subject"}, from ${r.from ?? "unknown"}, ${shortDate(r.createdAt)}${problem ? `. ${problem}` : ""}`}>
                <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
                  <Icon name={problem ? "alert-circle" : "check"} size={15} color={problem ? colors.warn : colors.ok} />
                  <Text style={{ flex: 1, color: colors.fg, fontSize: 15 }} numberOfLines={1}>{r.subject || "(no subject)"}</Text>
                  <Text style={{ color: colors.subtle, fontSize: 13 }}>{shortDate(r.createdAt)}</Text>
                </View>
                <Text style={{ color: colors.muted, fontSize: 13, paddingLeft: 23 }} numberOfLines={2}>{problem ?? r.from ?? ""}</Text>
              </View>
            );
          })}
        </Section>
        <View style={{ paddingHorizontal: space.lg, marginTop: space.xl, gap: space.sm }}>
          <Button label={mm.runRecent.isPending ? "Running" : "Run on recent mail"} icon="play" variant="secondary" onPress={runNow} loading={mm.runRecent.isPending} disabled={offline || !rule.enabled} testID="rule-run" />
          {!rule.enabled ? <Text style={{ color: colors.subtle, fontSize: 13, textAlign: "center" }}>Turn the rule on to run it.</Text> : null}
          {!web ? <Button label="Edit" icon="edit-3" variant="secondary" onPress={onEdit} disabled={offline} testID="rule-edit" /> : null}
          <Button label="Delete rule" icon="trash-2" variant="danger" onPress={() => setConfirm(true)} disabled={offline} testID="rule-delete" />
        </View>
      </ScrollView>
      <ConfirmSheet visible={confirm} title="Delete this rule?" body={`${rule.name} stops running. Mail it already sorted stays where it is.`} confirmLabel="Delete rule" cancelLabel="Keep rule"
        busy={mm.deleteRule.isPending} onConfirm={remove} onClose={() => setConfirm(false)} testID="rule-delete-confirm" />
    </View>
  );
}

function RuleForm({ rule, onDone }: { rule?: MailRule; onDone: () => void }) {
  const overview = useOverview();
  const tabs = useInboxTabs();
  const mm = useMailMutations();
  const offline = useOffline();
  const people = (overview.data ?? []).filter((m) => m.kind !== "agent");
  const [d, setD] = useState<RuleDraft>(() => (rule ? draftOf(rule) : emptyDraft(people[0]?.id ?? "")));
  const [shown, setShown] = useState<DraftProblems>({});
  const [tried, setTried] = useState(false);
  const [fieldFor, setFieldFor] = useState<number | null>(null);
  const [addAction, setAddAction] = useState(false);
  const [test, setTest] = useState<RuleTestResult | null>(null);
  const [runNow, setRunNow] = useState(false);
  useEffect(() => { if (!d.mailboxId && people[0]) setD((x) => ({ ...x, mailboxId: people[0].id })); }, [people, d.mailboxId]);
  const problems = checkDraft(d);
  useEffect(() => { if (tried) setShown(problems); }, [d, tried]); // eslint-disable-line react-hooks/exhaustive-deps
  const tabList = tabs.data?.tabs ?? [];
  const set = (patch: Partial<RuleDraft>) => { setTest(null); setD((x) => ({ ...x, ...patch })); };
  const setCond = (i: number, patch: Partial<RuleDraft["conditions"][number]>) => set({ conditions: d.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const setAct = (i: number, a: RuleAction) => set({ actions: d.actions.map((x, j) => (j === i ? a : x)) });
  const used = new Set(d.actions.map((a) => a.kind));
  const addable = PHONE_ACTIONS.filter((k) => k === "label" || !used.has(k)).filter((k) => k !== "move_to_tab" || tabList.length > 0);

  const check = () => {
    if (problems.conditions || problems.condition || !d.mailboxId) { setTried(true); setShown(problems); return; }
    mm.testRule.mutate({ mailboxId: d.mailboxId, match: d.match, conditions: toInput(d).conditions }, {
      onSuccess: (r) => { tick(); setTest(r); },
      onError: () => { warning(); showQuickToast("Couldn't check recent mail", "bad"); },
    });
  };
  const save = () => {
    setTried(true);
    setShown(problems);
    if (!draftOk(problems)) { warning(); return; }
    const input = toInput(d);
    const after = (id: string) => {
      success();
      if (runNow && !rule) mm.runRecent.mutate(id, { onSuccess: (r) => showQuickToast(r.ran ? `Rule saved and ran on ${r.ran} ${r.ran === 1 ? "email" : "emails"}` : "Rule saved") });
      else showQuickToast("Rule saved");
      onDone();
    };
    const fail = (e: Error) => { warning(); showQuickToast(e.message && e.message.length < 90 ? e.message : "Couldn't save the rule", "bad"); };
    if (rule) mm.updateRule.mutate({ id: rule.id, patch: input }, { onSuccess: () => after(rule.id), onError: fail });
    else mm.createRule.mutate(input, { onSuccess: (r) => after(r.rule.id), onError: fail });
  };
  const busy = mm.createRule.isPending || mm.updateRule.isPending;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: rule ? "Edit rule" : "New rule", headerRight: undefined }} />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: 64 }} keyboardShouldPersistTaps="handled" testID="rule-form">
        {offline ? <Banner text="You're offline. Save when you're back online." /> : null}
        <Field label="Name" value={d.name} onChangeText={(name) => set({ name })} placeholder="For example, Invoices" maxLength={80} error={shown.name} testID="rule-name" returnKeyType="next" />
        {people.length > 1 ? (
          <View style={{ gap: 6 }}>
            <Text style={{ color: colors.muted, fontSize: 14, fontWeight: "600" }}>Mailbox</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
              {people.map((m) => <Chip key={m.id} label={m.address} selected={d.mailboxId === m.id} onPress={() => { tick(); set({ mailboxId: m.id }); }} />)}
            </View>
          </View>
        ) : null}

        <View style={{ gap: space.sm }} testID="rule-conditions">
          <Text style={{ color: colors.fg, fontSize: 17, fontWeight: "700" }} accessibilityRole="header">When new mail</Text>
          {d.conditions.length > 1 ? <Segmented label="Match" value={d.match} onChange={(match) => { tick(); set({ match }); }} options={[{ id: "all", label: "Matches all" }, { id: "any", label: "Matches any" }]} /> : null}
          {d.conditions.map((c, i) => (
            <View key={i} style={{ backgroundColor: colors.surface, borderRadius: radius.md, padding: space.md, gap: space.sm }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                <Pressable onPress={() => { tick(); setFieldFor(i); }} accessibilityRole="button" accessibilityLabel={`Condition ${i + 1}: ${fieldLabel(c.field)}. Change`} testID={`cond-field-${i}`}
                  style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6, minHeight: TOUCH }}>
                  <Text style={{ color: colors.fg, fontSize: 16, fontWeight: "600" }}>{fieldLabel(c.field)}</Text>
                  <Icon name="chevron-down" size={16} color={colors.subtle} />
                </Pressable>
                {d.conditions.length > 1 ? <IconButton icon="x" label={`Remove condition ${i + 1}`} onPress={() => { tick(); set({ conditions: d.conditions.filter((_, j) => j !== i) }); }} testID={`cond-remove-${i}`} /> : null}
              </View>
              {fieldNeedsValue(c.field) ? (
                <Field label={`Value for ${fieldLabel(c.field).toLowerCase()}`} value={c.value} onChangeText={(value) => setCond(i, { value })} autoCapitalize="none" autoCorrect={false}
                  placeholder={RULE_FIELDS.find((f) => f.id === c.field)?.placeholder} maxLength={200} error={shown.condition?.[i]} testID={`cond-value-${i}`} />
              ) : null}
            </View>
          ))}
          {shown.conditions ? <Text style={{ color: colors.bad, fontSize: 13 }}>{shown.conditions}</Text> : null}
          {d.conditions.length < RULE_CONDITIONS_MAX ? <Button label="Add a condition" icon="plus" variant="secondary" onPress={() => { tick(); set({ conditions: [...d.conditions, { field: "subject", value: "" }] }); }} testID="cond-add" /> : null}
          <Button label={mm.testRule.isPending ? "Checking" : "Check recent mail"} icon="search" variant="secondary" onPress={check} loading={mm.testRule.isPending} disabled={offline} testID="rule-test" />
          {test ? (
            <View style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.brandLine, borderRadius: radius.md, padding: space.md, gap: 6 }} testID="rule-test-result" accessibilityLiveRegion="polite">
              <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "600" }}>
                {test.matched ? `Matches ${test.matched} of the last ${test.scanned} ${test.scanned === 1 ? "email" : "emails"}` : `No match in the last ${test.scanned} ${test.scanned === 1 ? "email" : "emails"}`}
              </Text>
              {test.sample.slice(0, 3).map((m) => <Text key={m.id} style={{ color: colors.muted, fontSize: 14 }} numberOfLines={1}>{m.from}: {m.subject || "(no subject)"}</Text>)}
              {!rule && test.matched ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, marginTop: 4 }}>
                  <Text style={{ flex: 1, color: colors.fg, fontSize: 15 }}>Also run it on these now</Text>
                  <Switch value={runNow} onValueChange={(v) => { tick(); setRunNow(v); }} accessibilityLabel="Also run it on these now" testID="rule-run-now" trackColor={{ true: colors.ok, false: colors.elevated }} />
                </View>
              ) : null}
              {!rule && test.matched ? <Text style={{ color: colors.subtle, fontSize: 13 }}>Moves and labels only. Nothing is sent.</Text> : null}
            </View>
          ) : null}
        </View>

        <View style={{ gap: space.sm }} testID="rule-actions">
          <Text style={{ color: colors.fg, fontSize: 17, fontWeight: "700" }} accessibilityRole="header">Then, in order</Text>
          {d.actions.map((a, i) => (
            <View key={i} style={{ backgroundColor: colors.surface, borderRadius: radius.md, padding: space.md, gap: space.sm }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                <Text style={{ color: colors.subtle, fontSize: 15, width: 20 }}>{i + 1}.</Text>
                <Text style={{ flex: 1, color: colors.fg, fontSize: 16, fontWeight: "600" }}>{ACTION_LABEL[a.kind]}</Text>
                <IconButton icon="x" label={`Remove ${ACTION_LABEL[a.kind].toLowerCase()}`} onPress={() => { tick(); set({ actions: d.actions.filter((_, j) => j !== i) }); }} testID={`act-remove-${i}`} />
              </View>
              {a.kind === "label" ? (
                <Field label="Label" value={a.label} onChangeText={(label) => setAct(i, { kind: "label", label })} placeholder="For example, Invoices" maxLength={40} error={shown.action?.[i]} testID={`act-label-${i}`} />
              ) : a.kind === "move_to_tab" ? (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                  {tabList.map((t) => <Chip key={t.id} label={t.name} selected={a.tab === t.id} onPress={() => { tick(); setAct(i, { kind: "move_to_tab", tab: t.id }); }} />)}
                </View>
              ) : shown.action?.[i] ? <Text style={{ color: colors.bad, fontSize: 13 }}>{shown.action[i]}</Text> : null}
            </View>
          ))}
          {shown.actions ? <Text style={{ color: colors.bad, fontSize: 13 }}>{shown.actions}</Text> : null}
          {d.actions.length < RULE_ACTIONS_MAX ? <Button label="Add an action" icon="plus" variant="secondary" onPress={() => { tick(); setAddAction(true); }} testID="act-add" /> : null}
          <Text style={{ color: colors.subtle, fontSize: 13 }}>Forwarding mail and sending a saved reply are set up on the web.</Text>
        </View>

        <Button label={busy ? "Saving" : rule ? "Save changes" : "Save rule"} onPress={save} loading={busy} disabled={offline} testID="rule-save" />
        {tried && !draftOk(shown) ? <Text style={{ color: colors.bad, fontSize: 13, textAlign: "center" }} accessibilityLiveRegion="polite">Check the parts marked in red.</Text> : null}
      </ScrollView>
      <ActionSheet visible={fieldFor !== null} title="Condition" options={RULE_FIELDS.map((f) => ({ id: f.id, label: f.label, selected: fieldFor !== null && d.conditions[fieldFor]?.field === f.id }))}
        onSelect={(id) => { if (fieldFor !== null) setCond(fieldFor, { field: id as RuleField }); setFieldFor(null); tick(); }} onClose={() => setFieldFor(null)} testID="cond-field-sheet" />
      <ActionSheet visible={addAction} title="Add an action" options={addable.map((k) => ({ id: k, label: ACTION_LABEL[k] }))}
        onSelect={(k) => { setAddAction(false); tick(); set({ actions: [...d.actions, newAction(k as RuleAction["kind"], tabList[0]?.id)] }); }} onClose={() => setAddAction(false)} testID="act-add-sheet" />
    </View>
  );
}
