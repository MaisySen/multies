/**
 * Round 22 (R22.5): the "Assign the thread" action in the automation dialog. A rule for new email can
 * give each new thread to one person or rotate through 2 to 20 people (round robin). automations.tsx
 * only mounts these.
 */
import { IconRepeat, IconUserRound } from "@/web/components/ui/icon";
import { Field, Select } from "@/web/components/ui/input";
import { useMailboxes } from "@/web/lib/queries";
import { useAssignees } from "./data";

type Cfg = Record<string, unknown>;

/** The sentence after "then" in the rule list. */
export function describeAssign(a: Cfg, names: Map<string, string>) {
  if (a.mode === "round_robin") {
    const ids = Array.isArray(a.userIds) ? (a.userIds as string[]) : [];
    return `assign the thread in turn to ${ids.map((id) => names.get(id) ?? "a teammate").join(", ") || "the team"}`;
  }
  return `assign the thread to ${(typeof a.userId === "string" && names.get(a.userId)) || "a teammate"}`;
}

/** Workspace people by user id, for describeAssign. */
export function usePeopleNames() {
  const people = useAssignees();
  return new Map((people.data ?? []).filter((p) => p.type === "member").map((p) => [p.id.slice(7), p.name] as const));
}

/** Mailbox picker for email rules: an assign rule usually names the shared mailbox it hands out. */
export function MailboxField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const mailboxes = useMailboxes();
  return (
    <Field label="To mailbox">{(f) => (
      <Select {...f} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Any mailbox</option>
        {mailboxes.data?.map((m) => <option key={m.id} value={m.id}>{m.address}</option>)}
      </Select>
    )}</Field>
  );
}

export function AssignThreadFields({ config, onChange }: { config: Cfg; onChange: (c: Cfg) => void }) {
  const people = useAssignees();
  const members = (people.data ?? []).filter((p) => p.type === "member").map((p) => ({ id: p.id.slice(7), name: p.name }));
  const mode = config.mode === "round_robin" ? "round_robin" : "person";
  const picked = Array.isArray(config.userIds) ? (config.userIds as string[]) : [];
  const toggle = (id: string, on: boolean) => onChange({ mode: "round_robin", userIds: on ? [...picked, id] : picked.filter((x) => x !== id) });
  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="How to assign" className="inline-flex rounded-lg border border-line bg-surface p-0.5 text-[13px]">
        {([["person", "One person", IconUserRound], ["round_robin", "Round robin", IconRepeat]] as const).map(([k, label, Icon]) => (
          <button key={k} type="button" role="radio" aria-checked={mode === k}
            onClick={() => onChange(k === "person" ? { mode: "person" } : { mode: "round_robin", userIds: [] })}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 ${mode === k ? "bg-brand text-white" : "text-muted hover:text-ink"}`}>
            <Icon className="h-3.5 w-3.5" />{label}
          </button>
        ))}
      </div>
      {mode === "person" ? (
        <Field label="Assign to">{(f) => (
          <Select {...f} value={String(config.userId ?? "")} onChange={(e) => onChange({ mode: "person", userId: e.target.value })}>
            <option value="">Pick a person</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        )}</Field>
      ) : (
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium">Take turns (2 to 20 people)</legend>
          <ul className="max-h-48 space-y-1 overflow-auto rounded-lg border border-line p-2" aria-label="People in the rotation">
            {members.map((m) => (
              <li key={m.id}>
                <label className="flex items-center gap-2 text-[13px]">
                  <input type="checkbox" className="h-4 w-4 accent-[var(--color-brand)]" checked={picked.includes(m.id)} onChange={(e) => toggle(m.id, e.target.checked)} />
                  {m.name}
                  {picked.includes(m.id) && <span className="ml-auto text-[12px] tabular-nums text-subtle">{picked.indexOf(m.id) + 1}</span>}
                </label>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[12px] text-subtle">New threads go to each person in order. Anyone who can't open the mailbox is skipped.</p>
        </fieldset>
      )}
    </div>
  );
}
