import { LoadErrorInline } from "@/web/components/load-error-t1g";
/**
 * TD2 (FORMS_TD2): builder pieces for Forms pro: the extra question types and layout blocks, upload limits,
 * show or hide with groups of conditions, "required when" and "disabled when", and the form's page settings.
 */
import { useQuery } from "@tanstack/react-query";
import { IconClose, IconPlus } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { Button } from "@/web/components/ui/button";
import { Input, Select, Textarea } from "@/web/components/ui/input";
import { Switch } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";
import { isLayout, LOGIC_OP_LABELS, LOGIC_OPS, MAX_CONDITIONS, MAX_GROUPS, VALUELESS_OPS, type FieldLogic, type FormFieldType, type LogicCondition, type LogicOp } from "@/shared/form-logic";
import { FILE_KINDS, type Td2Settings } from "@/shared/forms-td2";
import type { DriveList } from "@/shared/drive";
import type { BuilderField } from "../form-logic-ui";

const small = "h-8 text-[13px]";

export const TD2_TYPE_LABELS: Partial<Record<FormFieldType, string>> = {
  time: "Time", datetime: "Date and time", url: "Web address", file: "File upload", signature: "Signature",
  heading: "Heading", paragraph: "Text block", divider: "Divider", image: "Image", page: "Page break",
};
export const BLOCKS: { type: FormFieldType; label: string }[] = [
  { type: "heading", label: "Heading" }, { type: "paragraph", label: "Text block" }, { type: "image", label: "Image" },
  { type: "divider", label: "Divider" }, { type: "page", label: "Page break" },
];
export const newBlock = (type: FormFieldType, id: string): BuilderField => ({
  id, type, label: type === "heading" ? "Section title" : TD2_TYPE_LABELS[type] ?? "Block", ...(type === "paragraph" ? { text: "Add your text here." } : {}),
});

function Conditions({ list, earlier, onChange, testId }: { list: LogicCondition[]; earlier: BuilderField[]; onChange: (next: LogicCondition[]) => void; testId: string }) {
  const usable = earlier.filter((e) => e.id && !isLayout(e.type));
  return (
    <>
      <ul className="space-y-1.5" data-testid={`${testId}-conditions`}>
        {list.map((c, ci) => {
          const src = usable.find((u) => u.id === c.field);
          const withOptions = src?.type === "select" || src?.type === "multiselect";
          const ops = LOGIC_OPS.filter((o) => (o === "gt" || o === "lt" ? ["number", "date", "rating", "datetime", "time"].includes(src?.type ?? "") : true));
          const set = (patch: Partial<LogicCondition>) => onChange(list.map((x, j) => (j === ci ? { ...x, ...patch } : x)));
          return (
            <li key={ci} className="grid grid-cols-[1fr_120px] items-center gap-1.5 sm:grid-cols-[1fr_130px_1fr_auto]" data-testid="logic-condition">
              <Select aria-label="Question" value={c.field} onChange={(e) => set({ field: e.target.value, value: "" })} className={small}>
                {usable.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
              </Select>
              <Select aria-label="Operator" value={c.op} onChange={(e) => set({ op: e.target.value as LogicOp })} className={small}>
                {ops.map((o) => <option key={o} value={o}>{LOGIC_OP_LABELS[o]}</option>)}
              </Select>
              {VALUELESS_OPS.includes(c.op) ? <span className="hidden sm:block" /> : withOptions ? (
                <Select aria-label="Value" value={c.value ?? ""} onChange={(e) => set({ value: e.target.value })} className={small}>
                  <option value="">Choose</option>{src?.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                </Select>
              ) : <Input aria-label="Value" value={c.value ?? ""} type={src?.type === "number" || src?.type === "rating" ? "number" : src?.type === "date" ? "date" : "text"} onChange={(e) => set({ value: e.target.value })} className={small} />}
              <button type="button" onClick={() => onChange(list.filter((_, j) => j !== ci))} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-subtle hover:bg-hover hover:text-bad focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand" aria-label="Remove condition"><IconClose className="h-3.5 w-3.5" /></button>
            </li>
          );
        })}
      </ul>
      {usable.length > 0 && list.length < MAX_CONDITIONS && (
        <Button size="sm" variant="ghost" className="mt-1" onClick={() => onChange([...list, { field: usable[usable.length - 1].id!, op: "is", value: "" }])}><IconPlus className="h-3.5 w-3.5" />Add condition</Button>
      )}
    </>
  );
}

/** One logic object: single conditions plus groups, joined by all or any; optionally "show" or "hide". */
export function ConditionSet({ title, value, earlier, onChange, withAction, testId }: {
  title: string; value: FieldLogic | null | undefined; earlier: BuilderField[]; onChange: (next: FieldLogic | null) => void; withAction?: boolean; testId: string;
}) {
  const l: FieldLogic = value ?? { join: "all", conditions: [] };
  const usable = earlier.filter((e) => e.id && !isLayout(e.type));
  const emit = (next: FieldLogic) => onChange(next.conditions.length || next.groups?.length ? next : null);
  const groups = l.groups ?? [];
  const count = l.conditions.length + groups.length;
  return (
    <div data-testid={testId}>
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[12.5px] font-medium">
        {withAction ? (
          <Select aria-label="Show or hide" value={l.action ?? "show"} onChange={(e) => emit({ ...l, action: e.target.value === "hide" ? "hide" : undefined })} className={cn(small, "w-auto")}>
            <option value="show">Show this when</option><option value="hide">Hide this when</option>
          </Select>
        ) : title}
        {count > 1 && (
          <Select aria-label="Match" value={l.join} onChange={(e) => emit({ ...l, join: e.target.value as "all" | "any" })} className={cn(small, "w-auto")}>
            <option value="all">all of these are true</option><option value="any">any of these is true</option>
          </Select>
        )}
      </div>
      {!usable.length ? <p className="text-[12px] text-subtle">Add a question above this one to use conditions.</p> : (
        <>
          <Conditions list={l.conditions} earlier={earlier} onChange={(conditions) => emit({ ...l, conditions })} testId={`${testId}-condition`} />
          {groups.map((g, gi) => (
            <div key={gi} className="mt-2 rounded-md border border-line p-2" data-testid={`${testId}-group`}>
              <div className="mb-1 flex items-center gap-1.5 text-[12px] text-muted">
                Group {gi + 1}:
                <Select aria-label={`Group ${gi + 1} match`} value={g.join} onChange={(e) => emit({ ...l, groups: groups.map((x, j) => (j === gi ? { ...x, join: e.target.value as "all" | "any" } : x)) })} className={cn(small, "w-auto")}>
                  <option value="all">all are true</option><option value="any">any is true</option>
                </Select>
                <button type="button" className="ml-auto rounded-md px-2 py-1 text-[12px] text-subtle hover:bg-hover hover:text-bad focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand" onClick={() => emit({ ...l, groups: groups.filter((_, j) => j !== gi) })}>Remove group</button>
              </div>
              <Conditions list={g.conditions} earlier={earlier} onChange={(conditions) => emit({ ...l, groups: conditions.length ? groups.map((x, j) => (j === gi ? { ...x, conditions } : x)) : groups.filter((_, j) => j !== gi) })} testId={`${testId}-group-condition`} />
            </div>
          ))}
          {groups.length < MAX_GROUPS && (
            <Button size="sm" variant="ghost" className="mt-1" onClick={() => emit({ ...l, groups: [...groups, { join: "any", conditions: [{ field: usable[usable.length - 1].id!, op: "is", value: "" }] }] })}><IconPlus className="h-3.5 w-3.5" />Add group</Button>
          )}
        </>
      )}
    </div>
  );
}

/** The TD2 logic block inside "Logic and rules": show or hide, required when, disabled when. */
export function Td2Logic({ field, earlier, onChange }: { field: BuilderField; earlier: BuilderField[]; onChange: (patch: Partial<BuilderField>) => void }) {
  return (
    <div className="space-y-3">
      <ConditionSet title="Show this when" withAction value={field.logic} earlier={earlier} onChange={(logic) => onChange({ logic })} testId="td2-show" />
      {!isLayout(field.type) && <>
        <ConditionSet title="Required when" value={field.requireWhen} earlier={earlier} onChange={(requireWhen) => onChange({ requireWhen })} testId="td2-require" />
        <ConditionSet title="Disabled when" value={field.disableWhen} earlier={earlier} onChange={(disableWhen) => onChange({ disableWhen })} testId="td2-disable" />
      </>}
      <p className="text-[12px] text-subtle">A hidden or disabled question is skipped, so it is never required and its answer is not kept.</p>
    </div>
  );
}

function ImagePicker({ value, onChange }: { value?: string; onChange: (id: string) => void }) {
  const q = useQuery({ queryKey: ["drive", "td2-images"], queryFn: () => api.get<DriveList>("/drive/list?view=recent"), staleTime: 60_000 });
  const images = (q.data?.items ?? []).filter((x) => x.kind === "file" && /^image\/(png|jpeg|gif|webp)$/.test(x.contentType ?? ""));
  if (q.isError) return <LoadErrorInline onRetry={() => q.refetch()} />;
  return (
    <Select aria-label="Image from Files" value={value ?? ""} onChange={(e) => onChange(e.target.value)} className={small} disabled={q.isPending}>
      <option value="">{q.isPending ? "Loading images" : images.length ? "Choose an image from Files" : "No images in Files yet"}</option>
      {images.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      {value && !images.some((x) => x.id === value) && <option value={value}>Current image</option>}
    </Select>
  );
}

/** Settings for the new types and blocks, under the label row. */
export function Td2FieldSettings({ field, onChange }: { field: BuilderField; onChange: (patch: Partial<BuilderField>) => void }) {
  if (field.type === "file") {
    const kinds = field.fileTypes ?? [];
    return (
      <div className="mt-2 space-y-2" data-testid="td2-file-settings">
        <fieldset>
          <legend className="mb-1 text-[12px] text-muted">Allowed files (none ticked means all of these)</legend>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {FILE_KINDS.map((k) => (
              <label key={k.id} className="flex items-center gap-1.5 text-[12.5px]">
                <input type="checkbox" checked={kinds.includes(k.id)} onChange={(e) => onChange({ fileTypes: e.target.checked ? [...kinds, k.id] : kinds.filter((x) => x !== k.id) })} />{k.label}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid grid-cols-2 gap-2">
          <Select aria-label="Largest file" value={String(field.maxSizeMb ?? 10)} onChange={(e) => onChange({ maxSizeMb: Number(e.target.value) })} className={small}>
            {[1, 2, 5, 10].map((n) => <option key={n} value={n}>Up to {n} MB each</option>)}
          </Select>
          <Select aria-label="How many files" value={String(field.maxFiles ?? 1)} onChange={(e) => onChange({ maxFiles: Number(e.target.value) })} className={small}>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n === 1 ? "One file" : `Up to ${n} files`}</option>)}
          </Select>
        </div>
      </div>
    );
  }
  if (field.type === "signature") return <p className="mt-2 text-[12px] text-subtle">People draw their signature, or type their name if they can't draw. It is saved as a picture with the answer.</p>;
  if (field.type === "heading") return <Input aria-label="Heading text below the title" placeholder="Optional line under the heading" value={field.text ?? ""} maxLength={2000} onChange={(e) => onChange({ text: e.target.value })} className={cn(small, "mt-2")} />;
  if (field.type === "paragraph") return <Textarea aria-label="Text" value={field.text ?? ""} maxLength={2000} onChange={(e) => onChange({ text: e.target.value })} className="mt-2 min-h-16 text-[13px]" />;
  if (field.type === "image") return (
    <div className="mt-2 grid gap-2 sm:grid-cols-2">
      <ImagePicker value={field.imageId} onChange={(imageId) => onChange({ imageId })} />
      <Input aria-label="Image description for screen readers" placeholder="Describe the image" value={field.imageAlt ?? ""} maxLength={200} onChange={(e) => onChange({ imageAlt: e.target.value })} className={small} />
    </div>
  );
  if (field.type === "page") return <p className="mt-2 text-[12px] text-subtle">Everything below starts a new page, with Back and Next.</p>;
  if (field.type === "rating") return (
    <label className="mt-2 flex items-center gap-1.5 text-[12.5px] text-muted"><input type="checkbox" checked={field.display === "stars"} onChange={(e) => onChange({ display: e.target.checked ? "stars" : undefined, ...(e.target.checked ? { rules: { min: 1, max: 5 } } : {}) })} />Show as stars</label>
  );
  return null;
}

/** Form level: progress bar and one question at a time. */
export function Td2FormSettings({ value, onChange }: { value: Td2Settings; onChange: (v: Td2Settings) => void }) {
  return (
    <div className="space-y-2" data-testid="td2-form-settings">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5">
        <div><div className="text-[13px] font-medium">Progress bar</div><div className="text-[12px] text-muted">Shows how far along people are when the form has pages.</div></div>
        <Switch checked={value.progress} onChange={(v) => onChange({ ...value, progress: v })} label="Progress bar" />
      </div>
      <div className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5">
        <div><div className="text-[13px] font-medium">One question at a time</div><div className="text-[12px] text-muted">Each question gets its own screen. Enter goes on, Shift and Enter goes back.</div></div>
        <Switch checked={value.oneAtATime} onChange={(v) => onChange({ ...value, oneAtATime: v })} label="One question at a time" />
      </div>
    </div>
  );
}
