/**
 * R95 smart repeat on the task's Repeat control: every weekday, the nth weekday of a month (a missing 5th falls back
 * to the last), counting from the due date or from when it was finished, the person's time zone (so 9 am stays 9 am
 * across daylight saving), a chores rotation between members, and a preview of the next dates.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Input, Select } from "@/web/components/ui/input";
import { cn } from "@/web/lib/cn";
import { describeRule, isEveryWeekday, previewDates, WEEKDAYS, type RepeatRule } from "@/shared/tasks-plus-r95";

type Rule = Omit<RepeatRule, "until"> & { until?: string | null; text?: string };
interface Person { type: "member" | "agent"; id: string; name: string }
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ORD: Record<number, string> = { 1: "1st", 2: "2nd", 3: "3rd", 4: "4th", 5: "5th", [-1]: "last" };
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
/** A rule's content as a stable string: keys sorted, empty values and the display text left out. */
export function ruleKey(r: Partial<Rule> | null | undefined): string {
  if (!r) return "null";
  const o = r as Record<string, unknown>;
  return JSON.stringify(Object.keys(o).filter((k) => k !== "text" && o[k] !== undefined && o[k] !== null).sort().map((k) => [k, o[k]]));
}

type Kind = "" | "daily" | "weekdays" | "weekly" | "monthly" | "yearly";
const kindOf = (r: Rule | null): Kind => !r ? "" : isEveryWeekday(r) ? "weekdays" : r.freq;

const waitingSaves = new Set<() => void>();
/** Saves every repeat change still waiting for its pause, now (before another edit of the task goes out). */
export function flushRepeatSaves() { for (const f of [...waitingSaves]) f(); }

export function RepeatPlus({ value: saved, due, people, onChange: save }: { value: Rule | null; due: string | null; people: Person[]; onChange: (r: Omit<Rule, "text"> | null) => void }) {
  // A local draft, so two quick changes (week then weekday) build on each other instead of on the last saved rule.
  // Saved rules are compared by content (keys sorted, text left out): an echo of what this picker sent, or of an older
  // save, never overwrites the draft; only a rule changed elsewhere does.
  const [value, setValue] = useState<Rule | null>(saved);
  const seen = useRef<Set<string>>(new Set([ruleKey(saved)]));
  useEffect(() => {
    const k = ruleKey(saved);
    if (seen.current.has(k)) { setValue((v) => (v && saved && ruleKey(v) === k ? { ...v, text: saved.text } : v)); return; }
    seen.current = new Set([k]);
    setValue(saved);
  }, [saved]);
  // Saves wait for a short pause, so a burst of changes is one save and two saves never race each other.
  const pending = useRef<{ r: Omit<Rule, "text"> | null; timer: ReturnType<typeof setTimeout> } | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => () => { const p = pending.current; if (p) { clearTimeout(p.timer); saveRef.current(p.r); } }, []);
  // suite-r10: a change still waiting for its pause is saved at once when the task's other fields are saved (Mark as
  // done right after picking Weekly): the repeat must reach the server first, or the done task makes no next one.
  useEffect(() => {
    const flush = () => { const p = pending.current; if (p) { clearTimeout(p.timer); pending.current = null; saveRef.current(p.r); } };
    waitingSaves.add(flush);
    return () => { waitingSaves.delete(flush); };
  }, []);
  const onChange = (r: Omit<Rule, "text"> | null) => {
    seen.current.add(ruleKey(r));
    setValue(r ? { ...r } : null);
    if (pending.current) clearTimeout(pending.current.timer);
    const timer = setTimeout(() => { pending.current = null; saveRef.current(r); }, 450);
    pending.current = { r, timer };
  };
  const kind = kindOf(value);
  const dueDate = due ? new Date(due) : null;
  const base = (): Omit<Rule, "text"> => ({ freq: value?.freq ?? "weekly", interval: value?.interval ?? 1, ...(value?.until ? { until: value.until } : {}),
    ...(value?.basis === "done" ? { basis: "done" } : {}), ...(value?.rotate?.length ? { rotate: value.rotate } : {}), tz: value?.tz || zone() });
  const emit = (r: Omit<Rule, "text">) => {
    const out: Omit<Rule, "text"> = { ...r };
    if (out.freq !== "weekly") delete out.weekdays;
    if (out.freq !== "monthly") { delete out.monthDay; delete out.nth; delete out.nthWeekday; }
    if (out.nth) delete out.monthDay;
    onChange(out);
  };
  const setKind = (k: Kind) => {
    if (!k) return onChange(null);
    const b = base();
    if (k === "weekdays") return emit({ ...b, freq: "weekly", interval: 1, weekdays: WEEKDAYS });
    emit({ ...b, freq: k, ...(k === "weekly" ? { weekdays: value?.weekdays && !isEveryWeekday(value) ? value.weekdays : dueDate ? [dueDate.getDay()] : undefined } : {}) });
  };
  const monthMode = value?.nth ? "nth" : "day";
  const nthGuess = dueDate ? (dueDate.getDate() + 7 > new Date(dueDate.getFullYear(), dueDate.getMonth() + 1, 0).getDate() ? -1 : Math.ceil(dueDate.getDate() / 7)) : 1;
  const preview = useMemo(() => {
    if (!value) return [];
    try { return previewDates(value as RepeatRule, dueDate ?? new Date(), 3); } catch { return []; }
  }, [value, due]); // eslint-disable-line react-hooks/exhaustive-deps
  const members = people.filter((p) => p.type === "member");
  const rotate = value?.rotate ?? [];
  const toggleRotate = (key: string) => {
    const next = rotate.includes(key) ? rotate.filter((k) => k !== key) : [...rotate, key];
    emit({ ...base(), ...value, rotate: next.length ? next : undefined } as Omit<Rule, "text">);
  };
  const fmt = (d: Date) => { // in the rule's own time zone, so "2nd Tue" reads as a Tuesday wherever the viewer is
    try { return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: value?.tz || undefined }); }
    catch { return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }); }
  };

  return (
    <div className="space-y-2" data-testid="repeat-picker">
      <div className="flex flex-wrap items-center gap-1.5">
        <Select aria-label="Repeat" value={kind} onChange={(e) => setKind(e.target.value as Kind)} className="h-8 w-auto text-[13px] max-sm:h-11 max-sm:text-base">
          <option value="">Does not repeat</option><option value="daily">Daily</option><option value="weekdays">Every weekday</option>
          <option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option>
        </Select>
        {kind && kind !== "weekdays" && (
          <label className="flex items-center gap-1 text-[12.5px] text-muted">every
            <Input aria-label="Repeat every" type="number" min={1} max={365} value={value?.interval ?? 1} onChange={(e) => emit({ ...base(), ...value, interval: Math.max(1, Math.min(365, Number(e.target.value) || 1)) } as Omit<Rule, "text">)} className="h-8 w-16 text-[13px] max-sm:h-11" />
          </label>
        )}
      </div>
      {kind === "weekly" && (
        <div className="flex flex-wrap gap-1" role="group" aria-label="Repeat on">
          {DAYS.map((d, i) => {
            const on = value?.weekdays?.includes(i) ?? false;
            return <button key={d} type="button" aria-pressed={on} onClick={() => emit({ ...base(), ...value, weekdays: on ? (value?.weekdays ?? []).filter((x) => x !== i) : [...(value?.weekdays ?? []), i].sort() } as Omit<Rule, "text">)}
              className={cn("min-h-7 rounded-md px-1.5 text-[11.5px] transition-colors duration-150 max-sm:min-h-11 max-sm:px-2.5", on ? "bg-brand text-brand-fg" : "border border-line text-muted hover:text-fg")}>{d}</button>;
          })}
        </div>
      )}
      {kind === "monthly" && (
        <div className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted">
          <span>On</span>
          <Select aria-label="Monthly on" value={monthMode} onChange={(e) => emit(e.target.value === "nth"
            ? { ...base(), ...value, freq: "monthly", nth: nthGuess, nthWeekday: dueDate?.getDay() ?? 1 } as Omit<Rule, "text">
            : { ...base(), ...value, freq: "monthly", nth: undefined, nthWeekday: undefined, monthDay: dueDate?.getDate() } as Omit<Rule, "text">)} className="h-8 w-auto text-[13px] max-sm:h-11">
            <option value="day">day {value?.monthDay ?? dueDate?.getDate() ?? "of the due date"}</option>
            <option value="nth">a weekday</option>
          </Select>
          {monthMode === "nth" && (
            <>
              <Select aria-label="Which week" value={value?.nth ?? 1} onChange={(e) => emit({ ...base(), ...value, nth: Number(e.target.value) } as Omit<Rule, "text">)} className="h-8 w-auto text-[13px] max-sm:h-11">
                {[1, 2, 3, 4, 5, -1].map((n) => <option key={n} value={n}>{ORD[n]}</option>)}
              </Select>
              <Select aria-label="Weekday" value={value?.nthWeekday ?? 1} onChange={(e) => emit({ ...base(), ...value, nthWeekday: Number(e.target.value) } as Omit<Rule, "text">)} className="h-8 w-auto text-[13px] max-sm:h-11">
                {LONG.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </Select>
            </>
          )}
        </div>
      )}
      {kind && (
        <label className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted">Count from
          <Select aria-label="Count from" value={value?.basis === "done" ? "done" : "due"} onChange={(e) => emit({ ...base(), ...value, basis: e.target.value === "done" ? "done" : undefined } as Omit<Rule, "text">)} className="h-8 w-auto text-[13px] max-sm:h-11">
            <option value="due">the due date</option><option value="done">when it is done</option>
          </Select>
        </label>
      )}
      {kind && members.length > 1 && (
        <div className="space-y-1">
          <p className="text-[12.5px] text-muted">Take turns (each new one goes to the next person)</p>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Take turns">
            {members.map((p) => {
              const key = `member:${p.id}`;
              const pos = rotate.indexOf(key);
              return <button key={key} type="button" aria-pressed={pos >= 0} onClick={() => toggleRotate(key)}
                className={cn("inline-flex min-h-7 items-center gap-1 rounded-full px-2 text-[12px] transition-colors duration-150 max-sm:min-h-11", pos >= 0 ? "bg-brand/15 text-fg ring-1 ring-brand/40" : "border border-line text-muted hover:text-fg")}>
                {pos >= 0 && <span className="grid h-4 w-4 place-items-center rounded-full bg-brand text-[10px] font-semibold text-brand-fg">{pos + 1}</span>}{p.name}
              </button>;
            })}
          </div>
        </div>
      )}
      {value && (
        <p className="text-[11.5px] text-subtle" data-testid="repeat-preview">
          {(() => { try { return `${describeRule(value as RepeatRule)}. `; } catch { return value.text ? `${value.text}. ` : ""; } })()}{preview.length ? `Next: ${preview.map(fmt).join(", ")}` : "No more dates."}{rotate.length > 1 ? ` Turns: ${rotate.length} people.` : ""}
        </p>
      )}
    </div>
  );
}
