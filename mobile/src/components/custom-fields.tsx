import { useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import type { Assignee, CustomField, FieldValue, FieldValues } from "@/api/types";
import { EDITABLE, formatDay, parseAmount, parseDay, showValue, type ShownValue } from "@/lib/fields";
import { dayFrom } from "@/lib/tasks";
import { Button, Chip, Field, Icon } from "./ui";
import { colors, radius, space } from "@/theme";

/**
 * The task's custom fields: every type is shown, and checkbox, select, text, number, currency,
 * date and URL can be changed here. Multi select and person are edited on the web. A checkbox
 * with no value is unticked: the server stores an unticked box as no value.
 */
export function CustomFields({ fields, values, people, onSet, readOnly }: {
  fields: CustomField[];
  values: FieldValues | undefined;
  people: Assignee[];
  onSet: (fieldId: string, value: FieldValue | null) => void;
  readOnly?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const sorted = [...fields].sort((a, b) => a.position - b.position);
  return (
    <View style={{ backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line }} testID="custom-fields">
      {sorted.map((f, i) => {
        const value = values?.[f.id];
        const shown = showValue(f, value, people);
        const editable = !readOnly && EDITABLE.has(f.type);
        const isOpen = open === f.id && editable;
        const press = () => {
          if (!editable) return;
          if (f.type === "checkbox") return onSet(f.id, value !== true);
          setOpen(isOpen ? null : f.id);
        };
        return (
          <View key={f.id} style={{ borderTopWidth: i ? 1 : 0, borderTopColor: colors.line }}>
            <Pressable onPress={press} disabled={!editable} testID={`field-${f.id}`}
              accessibilityRole={f.type === "checkbox" ? "checkbox" : editable ? "button" : "text"}
              accessibilityState={f.type === "checkbox" ? { checked: value === true, disabled: !editable } : isOpen ? { expanded: true } : undefined}
              aria-checked={f.type === "checkbox" ? value === true : undefined}
              accessibilityLabel={`${f.name}: ${f.type === "checkbox" ? (value === true ? "Yes" : "No") : shown.empty ? "not set" : shown.text}`}
              accessibilityHint={editable && f.type !== "checkbox" ? "Change this field" : undefined}
              style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.md, minHeight: 48, paddingVertical: 10 }}>
              <Text style={{ color: colors.muted, fontSize: 14, fontWeight: "500", width: 110 }} numberOfLines={2}>{f.name}</Text>
              <View style={{ flex: 1, alignItems: "flex-end" }}>
                {f.type === "checkbox" ? <Check on={value === true} /> : <Value field={f} shown={shown} />}
              </View>
              {editable && f.type !== "checkbox" ? <Icon name={isOpen ? "chevron-up" : "chevron-down"} size={16} color={colors.subtle} /> : null}
            </Pressable>
            {isOpen ? <Editor field={f} value={value} onSet={(v) => { onSet(f.id, v); if (f.type === "select" || f.type === "date") setOpen(null); }} onDone={() => setOpen(null)} /> : null}
          </View>
        );
      })}
    </View>
  );
}

function Value({ field, shown }: { field: CustomField; shown: ShownValue }) {
  if (shown.empty) return <Text style={{ color: colors.subtle, fontSize: 15 }}>-</Text>;
  if (shown.chips) {
    return (
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, justifyContent: "flex-end" }}>
        {shown.chips.map((c) => <Pill key={c.label} label={c.label} color={c.color} />)}
      </View>
    );
  }
  if (field.type === "url") {
    return (
      <Text style={{ color: colors.brand, fontSize: 15, textDecorationLine: "underline" }} numberOfLines={1} accessibilityRole="link"
        onPress={() => { Linking.openURL(/^https?:\/\//i.test(shown.text) ? shown.text : `https://${shown.text}`).catch(() => undefined); }}>
        {shown.text.replace(/^https?:\/\//i, "")}
      </Text>
    );
  }
  return <Text style={{ color: colors.fg, fontSize: 15, textAlign: "right" }} numberOfLines={3}>{shown.text}</Text>;
}

/** An option label in its own colour, as on the web board. */
export function Pill({ label, color }: { label: string; color: string | null }) {
  const c = color ?? colors.muted;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 9, paddingVertical: 3, borderRadius: radius.pill, backgroundColor: colors.neutralSoft, borderWidth: 1, borderColor: colors.line }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c }} />
      <Text style={{ color: colors.fg, fontSize: 13, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

function Check({ on }: { on: boolean }) {
  return (
    <View style={{ width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: on ? colors.brand : colors.lineStrong, backgroundColor: on ? colors.brand : "transparent", alignItems: "center", justifyContent: "center" }}>
      {on ? <Icon name="check" size={16} color={colors.brandFg} /> : null}
    </View>
  );
}

function Editor({ field, value, onSet, onDone }: { field: CustomField; value: FieldValue | null | undefined; onSet: (v: FieldValue | null) => void; onDone: () => void }) {
  const box = { paddingHorizontal: space.md, paddingBottom: space.md, gap: space.sm };
  if (field.type === "select") {
    return (
      <View style={[box, { flexDirection: "row", flexWrap: "wrap" }]} accessibilityRole="radiogroup" accessibilityLabel={field.name}>
        {field.options.map((o) => <Chip key={o.id} label={o.label} selected={value === o.id} onPress={() => onSet(value === o.id ? null : o.id)} />)}
        {value ? <Chip label="Clear" onPress={() => onSet(null)} /> : null}
      </View>
    );
  }
  if (field.type === "date") {
    const current = typeof value === "string" ? value : null;
    const picks = [{ label: "Today", value: dayFrom(0) }, { label: "Tomorrow", value: dayFrom(1) }, { label: "In a week", value: dayFrom(7) }];
    return (
      <View style={box}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          {picks.map((p) => <Chip key={p.label} label={p.label} selected={current === p.value} onPress={() => onSet(p.value)} />)}
          {current ? <Chip label="Clear" onPress={() => onSet(null)} /> : null}
        </View>
        <TextEditor field={field} initial={current ? formatDay(current) : ""} placeholder="DD/MM/YYYY" parse={parseDay} error="Use a date like 24/10/2026." onSet={onSet} onDone={onDone} />
      </View>
    );
  }
  const numeric = field.type === "number" || field.type === "currency";
  return (
    <View style={box}>
      <TextEditor field={field} initial={value === null || value === undefined ? "" : String(value)} placeholder={field.type === "currency" ? "Amount in AUD" : field.type === "url" ? "https://" : ""}
        parse={numeric ? parseAmount : (s) => s.trim()} error={numeric ? "Enter a number." : null} keyboard={numeric ? "decimal-pad" : field.type === "url" ? "url" : "default"}
        onSet={onSet} onDone={onDone} />
    </View>
  );
}

function TextEditor({ field, initial, placeholder, parse, error, keyboard = "default", onSet, onDone }: {
  field: CustomField; initial: string; placeholder: string; parse: (s: string) => FieldValue | null; error: string | null;
  keyboard?: "default" | "decimal-pad" | "url"; onSet: (v: FieldValue | null) => void; onDone: () => void;
}) {
  // A date shows as "24 Oct 2026" but is typed as 24/10/2026, so start that one empty.
  const [text, setText] = useState(field.type === "date" ? "" : initial);
  const [bad, setBad] = useState<string | null>(null);
  const save = () => {
    if (!text.trim()) { onSet(null); onDone(); return; }
    const v = parse(text);
    if (v === null || v === "") { setBad(error); return; }
    onSet(v);
    onDone();
  };
  return (
    <View style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-end" }}>
      <View style={{ flex: 1 }}>
        <Field label={field.type === "date" ? "Or type a date" : `Set ${field.name}`} value={text} onChangeText={(s) => { setText(s); setBad(null); }} placeholder={placeholder}
          keyboardType={keyboard} autoCapitalize="none" onSubmitEditing={save} returnKeyType="done" error={bad} testID={`field-input-${field.id}`} />
      </View>
      <Button label="Save" variant="secondary" onPress={save} style={{ minHeight: 48 }} testID={`field-save-${field.id}`} />
    </View>
  );
}
