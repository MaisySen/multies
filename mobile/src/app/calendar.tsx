import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { ScreenHeader, Problem } from "@/components/m3-ui";
import { Button, Field, Icon, IconButton, Loading, Segmented } from "@/components/ui";
import { Label, Note, Pill, Sheet, SheetAction } from "@/components/mpar3-ui";
import { colors, font, lh, radius, space, TOUCH } from "@/theme";
import { currentLocale, tr } from "@/i18n";
import { tick, success, warning } from "@/lib/haptics";
import { readPref, writePref } from "@/lib/startup-prefs";
import { openMeeting } from "@/lib/meetings";
import { useCreateMeeting, useTaskMutations } from "@/lib/queries";
import { useCalendarActions, useCalendarEvents, useCalendarSources } from "@/lib/mpar3-queries";
import { calFmt,
  CALENDAR_VIEWS, addDays, byDay, cleanLayers, dayKey, eventColor, eventTitle, isDay, layerOf, localMoment, meetingIdOf, monthGrid, parseDay,
  startOfDay, taskIdOf, weekOf, windowFor, type CalendarEvent, type CalendarView,
} from "@/lib/mpar3";

/**
 * MPAR3: Calendar on the phone, as on the web: meetings, task due dates and the person's other calendars in Month,
 * Week and Agenda views (GET /api/calendar/events). Meetings and tasks can be added and moved; other calendars are
 * read only and can be shown or hidden here (kept on this phone) or switched off in Calendar settings.
 */
const PREF = "calendar.hidden";
const PREF_VIEW = "calendar.view";
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(currentLocale(), { hour: "numeric", minute: "2-digit" });
const dayTitle = (d: Date) => calFmt(d, { weekday: "long", day: "numeric", month: "long" });

export default function CalendarScreen() {
  const [view, setViewState] = useState<CalendarView>(() => { const v = readPref(PREF_VIEW); return (CALENDAR_VIEWS as string[]).includes(v ?? "") ? (v as CalendarView) : "month"; });
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [picked, setPicked] = useState(() => dayKey(new Date()));
  const [hidden, setHiddenState] = useState<string[]>(() => { try { return cleanLayers(JSON.parse(readPref(PREF) ?? "[]")); } catch { return []; } });
  const [open, setOpen] = useState<CalendarEvent | null>(null);
  const [adding, setAdding] = useState(false);
  const win = useMemo(() => windowFor(view, anchor), [view, anchor]);
  const q = useCalendarEvents(win.from, win.to);
  const sources = useCalendarSources();
  const events = q.data?.events ?? [];
  const days = useMemo(() => byDay(events, hidden), [events, hidden]);
  const today = dayKey(new Date());

  // PRIV1b (P67): Agenda is "Next 30 days", so it starts from today, not from a month stepped to before.
  // Wave 3: Week opens on the picked day's week, so the pick made in Month stays in view (it showed today's week).
  const setView = (v: CalendarView) => { tick(); if (v === "agenda") setAnchor(startOfDay(new Date())); else if (v === "week") setAnchor(parseDay(picked)); setViewState(v); writePref(PREF_VIEW, v); };
  const setHidden = (next: string[]) => { setHiddenState(next); writePref(PREF, JSON.stringify(next)); };
  const toggle = (layer: string) => { tick(); setHidden(hidden.includes(layer) ? hidden.filter((x) => x !== layer) : [...hidden, layer]); };
  const step = (n: number) => {
    tick();
    const next = view === "month" ? new Date(anchor.getFullYear(), anchor.getMonth() + n, 1) : addDays(anchor, n * 7);
    setAnchor(next);
    setPicked(dayKey(view === "month" && next.getMonth() === new Date().getMonth() && next.getFullYear() === new Date().getFullYear() ? new Date() : next));
  };
  const goToday = () => { tick(); const t = startOfDay(new Date()); setAnchor(t); setPicked(dayKey(t)); };

  const layers = [
    { id: "meeting", label: tr("m.cal.meetings"), color: colors.brand },
    { id: "due", label: tr("m.cal.due_dates"), color: colors.warn },
    ...(sources.data ?? []).filter((s) => s.enabled).map((s) => ({ id: s.id, label: s.name, color: s.color })),
  ];
  const title = view === "month" ? calFmt(anchor, { month: "long", year: "numeric" })
    : view === "week" ? weekLabel(anchor) : tr("m.cal.next_30_days");

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="calendar-screen">
      <ScreenHeader title={tr("m.cal.title")} right={
        <View style={{ flexDirection: "row" }}>
          <IconButton icon="settings" label={tr("m.cal.settings")} onPress={() => router.push("/calendar-settings")} testID="calendar-settings-link" />
          <IconButton icon="plus" label={tr("m.cal.add")} onPress={() => { tick(); setAdding(true); }} testID="calendar-add" />
        </View>
      } />
      <ScrollView contentContainerStyle={{ paddingBottom: space.xxl }} refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { void q.refetch(); void sources.refetch(); }} />}>
        <View style={{ paddingHorizontal: space.lg, gap: space.md, paddingTop: space.sm }}>
          <Segmented value={view} label={tr("m.cal.view")} onChange={setView} options={CALENDAR_VIEWS.map((v) => ({ id: v, label: tr(`m.cal.view_${v}`) }))} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }} testID="calendar-layers">
            {layers.map((l) => <Pill key={l.id} label={l.label} color={l.color} selected={!hidden.includes(l.id)} onPress={() => toggle(l.id)} testID={`layer-${l.id}`} />)}
          </ScrollView>
          <View style={s.nav}>
            {view !== "agenda" ? <IconButton icon="chevron-left" label={view === "month" ? tr("m.cal.prev_month") : tr("m.cal.prev_week")} onPress={() => step(-1)} testID="calendar-prev" /> : null}
            <Text style={s.navTitle} accessibilityRole="header" numberOfLines={1} testID="calendar-title">{title}</Text>
            {view !== "agenda" ? <IconButton icon="chevron-right" label={view === "month" ? tr("m.cal.next_month") : tr("m.cal.next_week")} onPress={() => step(1)} testID="calendar-next" /> : null}
            <Pressable onPress={goToday} accessibilityRole="button" accessibilityLabel={tr("m.cal.today")} style={({ pressed }) => [s.todayBtn, pressed && { opacity: 0.7 }]} testID="calendar-today">
              <Text style={{ color: colors.fg, fontWeight: "600", fontSize: 15, lineHeight: lh(20) }}>{tr("m.cal.today")}</Text>
            </Pressable>
          </View>
        </View>
        {q.isLoading ? <Loading label={tr("m.cal.loading")} rows={5} variant="task" /> : q.error && !q.data ? <Problem q={q} what={tr("m.cal.title")} testID="calendar-problem" /> : (
          <>
            {q.data?.errors?.length ? <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm }}><Note tone="bad">{tr("m.cal.source_errors", { names: q.data.errors.map((e) => e.name).join(", ") })}</Note></View> : null}
            {view === "month" ? <MonthGrid anchor={anchor} days={days} picked={picked} today={today} onPick={(k) => { tick(); setPicked(k); }} /> : null}
            {view === "week" ? <WeekStrip anchor={anchor} days={days} picked={picked} today={today} onPick={(k) => { tick(); setPicked(k); }} /> : null}
            {view === "agenda" ? <Agenda from={anchor} days={days} today={today} onOpen={setOpen} /> : (
              <DayList day={picked} list={days.get(picked) ?? []} onOpen={setOpen} onAdd={() => setAdding(true)} />
            )}
          </>
        )}
      </ScrollView>
      <EventSheet event={open} onClose={() => setOpen(null)} />
      <AddSheet visible={adding} day={picked} onClose={() => setAdding(false)} />
    </View>
  );
}

function weekLabel(anchor: Date) {
  const w = weekOf(anchor);
  const a = calFmt(w[0], { day: "numeric", month: "short" });
  const b = calFmt(w[6], { day: "numeric", month: "short" });
  return tr("m.cal.week_range", { from: a, to: b });
}

function Dots({ list }: { list: CalendarEvent[] }) {
  const shown = list.slice(0, 3);
  return (
    <View style={{ flexDirection: "row", gap: 3, height: 6, justifyContent: "center" }}>
      {shown.map((e, i) => <View key={`${e.id}-${i}`} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: eventColor(e, colors) }} />)}
    </View>
  );
}

function MonthGrid({ anchor, days, picked, today, onPick }: { anchor: Date; days: Map<string, CalendarEvent[]>; picked: string; today: string; onPick: (k: string) => void }) {
  const grid = monthGrid(anchor.getFullYear(), anchor.getMonth());
  const heads = grid.slice(0, 7).map((d) => calFmt(d.date, { weekday: "narrow" }));
  return (
    <View style={s.month} testID="calendar-month">
      <View style={s.weekRow} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {heads.map((h, i) => <Text key={i} style={s.weekHead}>{h}</Text>)}
      </View>
      {Array.from({ length: 6 }, (_, r) => (
        <View key={r} style={s.weekRow}>
          {grid.slice(r * 7, r * 7 + 7).map((d) => {
            const list = days.get(d.key) ?? [];
            const sel = d.key === picked; const now = d.key === today;
            return (
              <Pressable key={d.key} onPress={() => onPick(d.key)} accessibilityRole="button" accessibilityState={{ selected: sel }}
                accessibilityLabel={`${calFmt(d.date, { weekday: "long", day: "numeric", month: "long" })}${list.length ? `, ${tr("m.cal.n_events", { count: list.length })}` : ""}`}
                testID={`day-${d.key}`} style={({ pressed }) => [s.cell, pressed && { backgroundColor: colors.hover }]}>
                <View style={[s.num, sel && { backgroundColor: colors.brandFill }, !sel && now && { borderWidth: 1.5, borderColor: colors.brand }]}>
                  <Text style={[s.numText, { color: sel ? colors.brandFg : !d.inMonth ? colors.subtle : now ? colors.brand : colors.fg }, sel && { fontWeight: "700" }]}>{calFmt(d.date, { day: "numeric" })}</Text>
                </View>
                <Dots list={list} />
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function WeekStrip({ anchor, days, picked, today, onPick }: { anchor: Date; days: Map<string, CalendarEvent[]>; picked: string; today: string; onPick: (k: string) => void }) {
  return (
    <View style={[s.weekRow, { paddingHorizontal: space.md, paddingTop: space.md }]} testID="calendar-week">
      {weekOf(anchor).map((d) => {
        const k = dayKey(d); const sel = k === picked; const list = days.get(k) ?? [];
        return (
          <Pressable key={k} onPress={() => onPick(k)} accessibilityRole="button" accessibilityState={{ selected: sel }} testID={`day-${k}`}
            accessibilityLabel={`${calFmt(d, { weekday: "short" })} ${calFmt(d, { day: "numeric" })}, ${dayTitle(d)}${list.length ? `, ${tr("m.cal.n_events", { count: list.length })}` : ""}`}
            style={({ pressed }) => [s.weekDay, sel && { backgroundColor: colors.brandFill }, !sel && k === today && { borderWidth: 1.5, borderColor: colors.brand }, pressed && !sel && { backgroundColor: colors.hover }]}>
            <Text style={{ fontSize: 12, lineHeight: lh(16), color: sel ? colors.brandFg : colors.subtle }} numberOfLines={1}>{calFmt(d, { weekday: "short" })}</Text>
            <Text style={{ fontSize: 17, lineHeight: lh(22), fontWeight: "600", color: sel ? colors.brandFg : colors.fg }}>{calFmt(d, { day: "numeric" })}</Text>
            <View style={{ height: 6 }}>{!sel ? <Dots list={list} /> : null}</View>
          </Pressable>
        );
      })}
    </View>
  );
}

function DayList({ day, list, onOpen, onAdd }: { day: string; list: CalendarEvent[]; onOpen: (e: CalendarEvent) => void; onAdd: () => void }) {
  return (
    <View style={{ paddingHorizontal: space.lg, paddingTop: space.lg, gap: space.sm }} testID="calendar-day">
      <Text style={font.headline} accessibilityRole="header">{dayTitle(parseDay(day))}</Text>
      {list.length ? <View style={s.list}>{list.map((e, i) => <EventRow key={`${e.id}-${i}`} e={e} first={i === 0} onPress={() => onOpen(e)} />)}</View> : (
        <View style={s.empty}>
          <Text style={font.small}>{tr("m.cal.nothing_this_day")}</Text>
          <Button variant="ghost" icon="plus" label={tr("m.cal.add")} onPress={onAdd} testID="calendar-empty-add" style={{ alignSelf: "flex-start", minHeight: TOUCH }} />
        </View>
      )}
    </View>
  );
}

function Agenda({ from, days, today, onOpen }: { from: Date; days: Map<string, CalendarEvent[]>; today: string; onOpen: (e: CalendarEvent) => void }) {
  const keys = Array.from({ length: 30 }, (_, i) => dayKey(addDays(from, i))).filter((k) => days.get(k)?.length);
  if (!keys.length) return <View style={[s.empty, { marginHorizontal: space.lg, marginTop: space.lg }]} testID="calendar-agenda"><Text style={font.small}>{tr("m.cal.nothing_coming")}</Text></View>;
  return (
    <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, gap: space.lg }} testID="calendar-agenda">
      {keys.map((k) => (
        <View key={k} style={{ gap: space.sm }}>
          <Text style={[font.headline, k === today && { color: colors.brand }]} accessibilityRole="header">{k === today ? tr("m.cal.today_is", { day: dayTitle(parseDay(k)) }) : dayTitle(parseDay(k))}</Text>
          <View style={s.list}>{(days.get(k) ?? []).map((e, i) => <EventRow key={`${e.id}-${i}`} e={e} first={i === 0} onPress={() => onOpen(e)} />)}</View>
        </View>
      ))}
    </View>
  );
}

function kindLabel(e: CalendarEvent) {
  return e.kind === "meeting" ? tr("m.cal.meeting") : e.kind === "due" ? tr("m.cal.due") : e.sourceName ?? tr("m.cal.other_calendar");
}

function EventRow({ e, first, onPress }: { e: CalendarEvent; first: boolean; onPress: () => void }) {
  const when = e.allDay ? tr("m.cal.all_day") : timeOf(e.start);
  const name = eventTitle(e);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${when}, ${name}, ${e.location ? `${kindLabel(e)} · ${e.location}` : kindLabel(e)}`} testID={`event-${e.id}`}
      style={({ pressed }) => [s.row, !first && s.rowLine, pressed && { backgroundColor: colors.hover }]}>
      <View style={[s.bar, { backgroundColor: eventColor(e, colors) }]} />
      <Text style={s.when} numberOfLines={1}>{when}</Text>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={s.rowTitle} numberOfLines={2}>{name}</Text>
        <Text style={s.rowSub} numberOfLines={1}>{e.location ? `${kindLabel(e)} · ${e.location}` : kindLabel(e)}</Text>
      </View>
      <Icon name="chevron-right" size={18} color={colors.subtle} />
    </Pressable>
  );
}

/** One event: join or read notes for a meeting, open or move a task's date, read an event from another calendar. */
function EventSheet({ event, onClose }: { event: CalendarEvent | null; onClose: () => void }) {
  const act = useCalendarActions();
  const [moving, setMoving] = useState(false);
  const [day, setDay] = useState("");
  const [time, setTime] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const e = event;
  const close = () => { setMoving(false); setErr(null); onClose(); };
  if (!e) return null;
  const mid = meetingIdOf(e); const tid = taskIdOf(e);
  const startMove = () => { tick(); setErr(null); setDay(e.allDay ? e.start.slice(0, 10) : dayKey(new Date(e.start))); setTime(e.allDay ? "09:00" : new Date(e.start).toTimeString().slice(0, 5)); setMoving(true); };
  const save = async () => {
    setErr(null);
    try {
      if (tid) {
        if (!isDay(day)) return setErr(tr("m.cal.day_bad"));
        await act.moveTask.mutateAsync({ id: tid, due: day });
      } else if (mid) {
        const at = localMoment(day, time);
        if (!at) return setErr(tr("m.cal.time_bad"));
        await act.moveMeeting.mutateAsync({ id: mid, startsAt: at.toISOString() });
      }
      success(); close();
    } catch (x) { warning(); setErr((x as Error).message || tr("m.cal.save_failed")); }
  };
  const when = e.allDay ? tr("m.cal.all_day") : `${timeOf(e.start)} ${tr("m.cal.to")} ${timeOf(e.end)}`;
  return (
    <Sheet visible onClose={close} title={eventTitle(e)} subtitle={`${dayTitle(e.allDay ? parseDay(e.start.slice(0, 10)) : new Date(e.start))}, ${when}`} testID="event-sheet">
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <View style={[s.bar, { height: 16, backgroundColor: eventColor(e, colors) }]} />
        <Text style={font.small}>{kindLabel(e)}{e.location ? ` · ${e.location}` : ""}</Text>
      </View>
      {e.readOnly || e.kind === "external" ? <Note>{tr("m.cal.read_only", { name: e.sourceName ?? tr("m.cal.other_calendar") })}</Note> : null}
      {moving ? (
        <View style={{ gap: space.sm }}>
          <Field label={tr("m.cal.date")} value={day} onChangeText={setDay} placeholder="2026-11-05" autoCapitalize="none" testID="move-day" />
          {mid ? <Field label={tr("m.cal.time")} value={time} onChangeText={setTime} placeholder="09:30" autoCapitalize="none" testID="move-time" /> : null}
          {err ? <Note tone="bad">{err}</Note> : null}
          <Button label={tr("common.save")} onPress={save} loading={act.moveTask.isPending || act.moveMeeting.isPending} testID="move-save" />
        </View>
      ) : (
        <View>
          {mid && e.url ? <SheetAction icon="video" label={tr("m.cal.join")} onPress={() => { tick(); void openMeeting(e.url!); }} testID="event-join" /> : null}
          {mid ? <SheetAction icon="file-text" label={tr("m.cal.notes")} onPress={() => { close(); router.push(`/meeting-notes/${mid}`); }} testID="event-notes" /> : null}
          {mid && !e.id.includes(":") ? <SheetAction icon="clock" label={tr("m.cal.change_time")} onPress={startMove} testID="event-move" /> : null}
          {tid ? <SheetAction icon="check-square" label={tr("m.cal.open_task")} onPress={() => { close(); router.push(`/task/${tid}`); }} testID="event-task" /> : null}
          {tid ? <SheetAction icon="calendar" label={tr("m.cal.change_due")} onPress={startMove} testID="event-move" /> : null}
          {mid && e.id.includes(":") ? <Note>{tr("m.cal.repeat_note")}</Note> : null}
        </View>
      )}
    </Sheet>
  );
}

/** Adds a meeting at a time, or a task due on a day. */
function AddSheet({ visible, day: initialDay, onClose }: { visible: boolean; day: string; onClose: () => void }) {
  const [kind, setKind] = useState<"meeting" | "task">("meeting");
  const [title, setTitle] = useState("");
  const [day, setDay] = useState(initialDay);
  const [time, setTime] = useState("10:00");
  const [mins, setMins] = useState(30);
  const [err, setErr] = useState<string | null>(null);
  const [lastDay, setLastDay] = useState(initialDay);
  if (initialDay !== lastDay) { setLastDay(initialDay); setDay(initialDay); }
  const meeting = useCreateMeeting();
  const tasks = useTaskMutations();
  const qc = useQueryClient();
  const close = () => { setErr(null); setTitle(""); onClose(); };
  const quick = [{ id: dayKey(new Date()), label: tr("m.cal.today") }, { id: dayKey(addDays(new Date(), 1)), label: tr("m.cal.tomorrow") }];
  const save = async () => {
    setErr(null);
    if (!title.trim()) return setErr(tr("m.cal.title_needed"));
    if (!isDay(day)) return setErr(tr("m.cal.day_bad"));
    try {
      if (kind === "meeting") {
        const at = localMoment(day, time);
        if (!at) return setErr(tr("m.cal.time_bad"));
        await meeting.mutateAsync({ title: title.trim(), startsAt: at.toISOString(), durationMin: mins });
      } else {
        await tasks.create.mutateAsync({ title: title.trim(), due: day });
      }
      // PRIV1b (P67): the new meeting or due date shows at once, not after the events query goes stale.
      void qc.invalidateQueries({ queryKey: ["calendar"] });
      success(); close();
    } catch (x) { warning(); setErr((x as Error).message || tr("m.cal.save_failed")); }
  };
  return (
    <Sheet visible={visible} onClose={close} title={tr("m.cal.add_title")} testID="calendar-add-sheet"
      footer={<Button label={kind === "meeting" ? tr("m.cal.add_meeting") : tr("m.cal.add_task")} onPress={save} loading={meeting.isPending || tasks.create.isPending} testID="calendar-add-save" />}>
      <Segmented value={kind} label={tr("m.cal.add_kind")} onChange={setKind} options={[{ id: "meeting", label: tr("m.cal.meeting") }, { id: "task", label: tr("m.cal.task_due") }]} />
      <Field label={tr("m.cal.what")} value={title} onChangeText={setTitle} placeholder={kind === "meeting" ? tr("m.cal.what_meeting") : tr("m.cal.what_task")} testID="calendar-add-title" />
      <View style={{ gap: space.sm }}>
        <Field label={tr("m.cal.date")} value={day} onChangeText={setDay} placeholder="2026-11-05" autoCapitalize="none" testID="calendar-add-day" />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          {quick.map((x) => <Pill key={x.id} label={x.label} selected={day === x.id} onPress={() => setDay(x.id)} />)}
        </View>
      </View>
      {kind === "meeting" ? (
        <View style={{ gap: space.sm }}>
          <Field label={tr("m.cal.time")} value={time} onChangeText={setTime} placeholder="09:30" autoCapitalize="none" testID="calendar-add-time" />
          <Label>{tr("m.cal.length")}</Label>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            {[15, 30, 45, 60].map((n) => <Pill key={n} label={tr("m.cal.n_min", { n })} selected={mins === n} onPress={() => setMins(n)} testID={`mins-${n}`} />)}
          </View>
        </View>
      ) : <Note>{tr("m.cal.task_note")}</Note>}
      {err ? <Note tone="bad">{err}</Note> : null}
    </Sheet>
  );
}

const s = StyleSheet.create({
  nav: { flexDirection: "row", alignItems: "center", gap: space.xs },
  navTitle: { flex: 1, textAlign: "center", color: colors.fg, fontSize: 17, fontWeight: "600", lineHeight: lh(22) },
  todayBtn: { minHeight: TOUCH, minWidth: TOUCH, paddingHorizontal: space.md, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: colors.brandSoft },
  month: { marginHorizontal: space.md, marginTop: space.md, backgroundColor: colors.surface, borderRadius: 14, paddingVertical: space.sm },
  weekRow: { flexDirection: "row" },
  weekHead: { flex: 1, textAlign: "center", color: colors.subtle, fontSize: 12, fontWeight: "600", lineHeight: lh(18), paddingBottom: 4 },
  cell: { flex: 1, minHeight: 48, alignItems: "center", justifyContent: "flex-start", paddingTop: 2, gap: 3, borderRadius: radius.sm },
  num: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  numText: { fontSize: 16, lineHeight: lh(21), fontVariant: ["tabular-nums"] },
  weekDay: { flex: 1, minHeight: 64, marginHorizontal: 2, borderRadius: radius.md, alignItems: "center", justifyContent: "center", gap: 2, backgroundColor: colors.surface },
  list: { backgroundColor: colors.surface, borderRadius: 14, overflow: "hidden" },
  row: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.sm, paddingRight: space.md },
  rowLine: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  bar: { width: 4, alignSelf: "stretch", borderRadius: 2, marginLeft: space.sm },
  when: { width: 72, color: colors.muted, fontSize: 14, lineHeight: lh(19), fontVariant: ["tabular-nums"] },
  rowTitle: { color: colors.fg, fontSize: 16, fontWeight: "600", lineHeight: lh(21) },
  rowSub: { color: colors.subtle, fontSize: 13, lineHeight: lh(18) },
  empty: { backgroundColor: colors.surface, borderRadius: 14, padding: space.lg, gap: space.sm },
});
