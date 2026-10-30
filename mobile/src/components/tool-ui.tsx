import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { API_BASE } from "@/config";
import { ActionSheet } from "./action-sheet";
import { Field, Icon, Segmented, TILE, type IconName } from "./ui";
import { tick } from "@/lib/haptics";
import { useSession } from "@/lib/session";
import { middleTruncate, sizeLabel, SECTION_TILE, type Entry } from "@/lib/tool-directory";
import { toolTakes, type ToolDef, type ToolOption } from "@/lib/tools";
import type { Attachment, MessageSummary } from "@/api/types";
import { colors, radius, space, TOUCH } from "@/theme";

/**
 * Tools P2 on the phone: the pieces the Tools screen and every tool screen share (search, tool rows, file chips,
 * the Upload, Work, Done steps, option fields, the mail attachment picker). Plain React Native, no native module.
 */

/** Opens a Tools page that needs the web (page editor, forms, compare, share links, workflows, templates) in the in app browser. */
export function openOnWeb(path: string) {
  WebBrowser.openBrowserAsync(`${API_BASE}${path}`, { dismissButtonStyle: "done", controlsColor: colors.brand }).catch(() => {});
}

/** The search field at the top of Tools. */
export function ToolSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: TOUCH, paddingHorizontal: space.md, borderRadius: radius.md, backgroundColor: colors.elevated }}>
      <Icon name="search" size={18} color={colors.subtle} />
      <TextInput value={value} onChangeText={onChange} placeholder="Search tools" placeholderTextColor={colors.subtle} accessibilityLabel="Search tools" testID="tools-search"
        autoCorrect={false} autoCapitalize="none" returnKeyType="search" clearButtonMode="never" selectionColor={colors.brand}
        style={[{ flex: 1, minHeight: TOUCH, color: colors.fg, fontSize: 17 }, Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : null]} />
      {value ? (
        <Pressable onPress={() => onChange("")} accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={10} testID="tools-search-clear">
          <Icon name="x" size={18} color={colors.subtle} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** A tool's icon on its section's colour. */
export function ToolTile({ entry, size = 32 }: { entry: Pick<Entry, "icon" | "section">; size?: number }) {
  return (
    <View style={{ width: size, height: size, borderRadius: Math.round(size * 0.26), backgroundColor: TILE[SECTION_TILE[entry.section]], alignItems: "center", justifyContent: "center" }}>
      <Icon name={entry.icon} size={Math.round(size * 0.56)} color="#FFFFFF" filled />
    </View>
  );
}

/** One tool in a list: tile, short name, one line. Web pages say so on the right. */
export function ToolRow({ entry, onPress, last }: { entry: Entry; onPress: () => void; last?: boolean }) {
  return (
    <Pressable onPress={() => { tick(); onPress(); }} accessibilityRole="button" testID={`tool-${entry.key}`}
      accessibilityLabel={entry.web ? `${entry.name}, ${entry.line}. Opens on the web` : `${entry.name}, ${entry.line}`}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.md, paddingLeft: space.lg, backgroundColor: pressed ? colors.hover : "transparent" })}>
      <ToolTile entry={entry} />
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 58, paddingVertical: 10, paddingRight: space.lg, borderBottomWidth: last ? 0 : 0.5, borderBottomColor: colors.line }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: colors.fg, fontSize: 16, fontWeight: "500" }} numberOfLines={1}>{entry.name}</Text>
          <Text style={{ color: colors.subtle, fontSize: 13.5 }} numberOfLines={1}>{entry.line}</Text>
        </View>
        {entry.web ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Text style={{ color: colors.subtle, fontSize: 13 }}>On web</Text>
            <Icon name="external-link" size={14} color={colors.subtle} />
          </View>
        ) : <Icon name="chevron-right" size={16} color={colors.subtle} />}
      </View>
    </Pressable>
  );
}

/** A rounded group of tool rows with a small header, like the phone's own settings lists. */
export function ToolGroup({ title, entries, onOpen, testID }: { title: string; entries: Entry[]; onOpen: (e: Entry) => void; testID?: string }) {
  return (
    <View style={{ gap: 6 }} testID={testID}>
      <Text style={{ color: colors.subtle, fontSize: 13, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.3, paddingHorizontal: space.lg }} accessibilityRole="header">{title}</Text>
      <View style={{ marginHorizontal: space.lg, borderRadius: 12, overflow: "hidden", backgroundColor: colors.surface }}>
        {entries.map((e, i) => <ToolRow key={e.key} entry={e} last={i === entries.length - 1} onPress={() => onOpen(e)} />)}
      </View>
    </View>
  );
}

/** Recent tools as a row of big tiles you can swipe through. */
export function RecentStrip({ entries, onOpen }: { entries: Entry[]; onOpen: (e: Entry) => void }) {
  if (!entries.length) return null;
  return (
    <View style={{ gap: 6 }} testID="tools-recent">
      <Text style={{ color: colors.subtle, fontSize: 13, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.3, paddingHorizontal: space.lg }} accessibilityRole="header">Recent</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.sm }}>
        {entries.map((e) => (
          <Pressable key={e.key} onPress={() => { tick(); onOpen(e); }} accessibilityRole="button" accessibilityLabel={e.web ? `${e.name}. Opens on the web` : e.name} testID={`recent-${e.key}`}
            style={({ pressed }) => ({ width: 92, minHeight: 92, padding: space.sm, borderRadius: 14, gap: space.sm, backgroundColor: pressed ? colors.hover : colors.surface })}>
            <ToolTile entry={e} size={34} />
            <Text style={{ color: colors.fg, fontSize: 13, fontWeight: "500", lineHeight: 17 }} numberOfLines={2}>{e.name}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

/** A picked file: icon, name truncated in the middle, size, and remove (and move, when the order matters). */
export function FileChip({ name, size, onRemove, onUp, onDown, index, uri, type, testID }: { name: string; size?: number; onRemove?: () => void; onUp?: () => void; onDown?: () => void; index?: number;
  /** R70: a photo or scan page shows itself, portrait and big enough to tell pages apart. */
  uri?: string; type?: string; testID?: string }) {
  const pdf = /\.pdf$/i.test(name);
  const picture = !!uri && /^(file|content|ph|blob|data|https?):/.test(uri) && (/^image\/(jpeg|png|webp|heic)/.test(type ?? "") || /\.(jpe?g|png|webp|heic)$/i.test(name));
  return (
    <View testID={testID} style={{ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: picture ? 92 : 56, paddingLeft: picture ? space.sm : space.md, paddingVertical: picture ? space.sm : 0, paddingRight: space.xs, borderRadius: radius.md, backgroundColor: colors.elevated }}>
      {picture ? (
        <View style={{ width: 56, height: 76 }} testID={testID ? `${testID}-thumb` : undefined}>
          <Image source={{ uri }} style={{ width: 56, height: 76, borderRadius: 6, backgroundColor: colors.surface }} resizeMode="cover" accessibilityIgnoresInvertColors />
          {index !== undefined ? <View style={{ position: "absolute", left: 4, top: 4, minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center" }}><Text style={{ color: "#FFFFFF", fontWeight: "700", fontSize: 12 }}>{index + 1}</Text></View> : null}
        </View>
      ) : (
      <View style={{ width: 34, height: 34, borderRadius: 8, backgroundColor: pdf ? "rgba(255,59,48,0.14)" : colors.brandSoft, alignItems: "center", justifyContent: "center" }}>
        {index !== undefined ? <Text style={{ color: pdf ? TILE.red : colors.brand, fontWeight: "700", fontSize: 13 }}>{index + 1}</Text> : <Icon name={pdf ? "file-text" : "paperclip"} size={17} color={pdf ? TILE.red : colors.brand} />}
      </View>
      )}
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "500" }} numberOfLines={1} accessibilityLabel={name}>{middleTruncate(name, 32)}</Text>
        {size ? <Text style={{ color: colors.subtle, fontSize: 13 }}>{sizeLabel(size)}</Text> : null}
      </View>
      {onUp ? <ChipButton icon="chevron-up" label={`Move ${name} up`} onPress={onUp} /> : null}
      {onDown ? <ChipButton icon="chevron-down" label={`Move ${name} down`} onPress={onDown} /> : null}
      {onRemove ? <ChipButton icon="x" label={`Remove ${name}`} onPress={onRemove} testID={testID ? `${testID}-remove` : undefined} /> : null}
    </View>
  );
}

function ChipButton({ icon, label, onPress, testID }: { icon: IconName; label: string; onPress: () => void; testID?: string }) {
  return (
    <Pressable onPress={() => { tick(); onPress(); }} accessibilityRole="button" accessibilityLabel={label} testID={testID}
      style={({ pressed }) => ({ width: TOUCH, height: TOUCH, alignItems: "center", justifyContent: "center", borderRadius: TOUCH / 2, backgroundColor: pressed ? colors.hover : "transparent" })}>
      <Icon name={icon} size={18} color={colors.subtle} />
    </Pressable>
  );
}

/** A source button for files (Files, Photos, From email). */
export function SourceButton({ icon, label, onPress, disabled, testID }: { icon: IconName; label: string; onPress: () => void; disabled?: boolean; testID?: string }) {
  return (
    <Pressable onPress={() => { tick(); onPress(); }} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }} testID={testID}
      style={({ pressed }) => ({ flex: 1, minHeight: 76, alignItems: "center", justifyContent: "center", gap: 6, borderRadius: radius.md, backgroundColor: pressed ? colors.hover : colors.surface, opacity: disabled ? 0.45 : 1, borderWidth: 1, borderColor: colors.line })}>
      <Icon name={icon} size={22} color={colors.brand} />
      <Text style={{ color: colors.fg, fontSize: 14, fontWeight: "500" }}>{label}</Text>
    </Pressable>
  );
}

export type StepKind = "upload" | "work" | "done";

/** Upload, Work, Done: where the run is, a bar, the line under it and Cancel. */
export function RunSteps({ at, pct, line, elapsed, note, onCancel }: { at: StepKind; pct: number | null; line: string; elapsed?: number; note?: string | null; onCancel?: () => void }) {
  const steps: { id: StepKind; label: string }[] = [{ id: "upload", label: "Upload" }, { id: "work", label: "Work" }, { id: "done", label: "Done" }];
  const atIdx = steps.findIndex((s) => s.id === at);
  return (
    <View style={{ gap: space.md, padding: space.lg, borderRadius: radius.lg, backgroundColor: colors.surface }} testID="tool-progress" accessibilityLiveRegion="polite">
      <View style={{ flexDirection: "row", alignItems: "center", alignSelf: "stretch" }}>
        {steps.flatMap((s, i) => {
          const doneStep = i < atIdx;
          const current = i === atIdx;
          const step = (
            <View key={s.id} style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 }} accessible accessibilityLabel={`${s.label}${doneStep ? ", done" : current ? ", now" : ""}`}>
              <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: doneStep ? TILE.green : current ? colors.brandFill : colors.elevated }}>
                {doneStep ? <Icon name="check" size={13} color="#FFFFFF" /> : <Text style={{ color: current ? "#FFFFFF" : colors.subtle, fontSize: 12, fontWeight: "700" }}>{i + 1}</Text>}
              </View>
              <Text style={{ color: current ? colors.fg : colors.subtle, fontSize: 13.5, fontWeight: current ? "600" : "400" }}>{s.label}</Text>
            </View>
          );
          if (i === steps.length - 1) return [step];
          return [step, <View key={`${s.id}-line`} style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 12, height: 1.5, marginHorizontal: space.sm, borderRadius: 1, backgroundColor: doneStep ? TILE.green : colors.line }} />];
        })}
      </View>
      <View style={{ height: 6, borderRadius: 3, overflow: "hidden", backgroundColor: colors.elevated }} accessibilityRole="progressbar"
        accessibilityValue={pct === null ? undefined : { min: 0, max: 100, now: pct }}>
        <View style={{ height: 6, width: `${pct === null ? 35 : Math.max(4, Math.min(100, pct))}%`, borderRadius: 3, backgroundColor: colors.brandFill, opacity: pct === null ? 0.5 : 1 }} />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <ActivityIndicator size="small" color={colors.brand} />
        <Text style={{ flex: 1, color: colors.fg, fontSize: 15 }} testID="tool-progress-line">{line}</Text>
        {elapsed && elapsed > 2 ? <Text style={{ color: colors.subtle, fontSize: 13, fontVariant: ["tabular-nums"] }}>{elapsed}s</Text> : null}
      </View>
      {note ? <Text style={{ color: colors.muted, fontSize: 13.5, lineHeight: 19, padding: space.sm, borderRadius: radius.sm, backgroundColor: colors.brandSoft }} testID="tool-waking">{note}</Text> : null}
      {onCancel ? (
        <Pressable onPress={onCancel} accessibilityRole="button" accessibilityLabel="Cancel this run" testID="tool-cancel" hitSlop={6}
          style={({ pressed }) => ({ alignSelf: "flex-start", minHeight: TOUCH, justifyContent: "center", paddingHorizontal: space.sm, marginLeft: -space.sm, borderRadius: radius.sm, backgroundColor: pressed ? colors.hover : "transparent" })}>
          <Text style={{ color: colors.bad, fontSize: 16, fontWeight: "600" }}>Cancel</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** One option: a sheet for long lists, segments for two or three choices, a text field otherwise. */
/** R70: the picked choice's own line (what a compress level will do), read out when it changes. */
function ChoiceHint({ o, value }: { o: ToolOption; value: string }) {
  const hint = o.choices?.find((c) => c.value === (value || String(o.default ?? "")))?.hint;
  if (!hint) return null;
  return <Text style={{ color: colors.muted, fontSize: 13.5, lineHeight: 19 }} accessibilityLiveRegion="polite" testID={`opt-${o.name}-hint`}>{hint}</Text>;
}

export function OptionField({ o, value, error, disabled, onChange }: { o: ToolOption; value: string; error?: string | null; disabled?: boolean; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  if (o.kind === "json") return null;
  if (o.kind === "choice" && o.choices?.length) {
    const fits = o.choices.length <= 3 && o.choices.every((c) => c.label.length <= 12);
    if (fits) {
      return (
        <View style={{ gap: 6 }}>
          <Text style={{ color: colors.muted, fontSize: 14, fontWeight: "500" }}>{o.label}</Text>
          <Segmented label={o.label} value={value || String(o.default ?? o.choices[0].value)} options={o.choices.map((c) => ({ id: c.value, label: c.label }))} onChange={(v) => !disabled && onChange(v)} />
          <ChoiceHint o={o} value={value} />
          {o.help ? <Text style={{ color: colors.subtle, fontSize: 13 }}>{o.help}</Text> : null}
        </View>
      );
    }
    const current = o.choices.find((c) => c.value === value) ?? o.choices.find((c) => c.value === String(o.default));
    return (
      <View style={{ gap: 6 }}>
        <Text style={{ color: colors.muted, fontSize: 14, fontWeight: "500" }}>{o.label}</Text>
        <Pressable onPress={() => { if (!disabled) { tick(); setOpen(true); } }} accessibilityRole="button" accessibilityLabel={`${o.label}, ${current?.label ?? "Choose"}`} testID={`opt-${o.name}`}
          style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", minHeight: TOUCH + 4, paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: pressed ? colors.hover : colors.surface })}>
          <Text style={{ flex: 1, color: colors.fg, fontSize: 16 }} numberOfLines={1}>{current?.label ?? "Choose"}</Text>
          <Icon name="chevron-down" size={16} color={colors.subtle} />
        </Pressable>
        <ChoiceHint o={o} value={value} />
        {o.help ? <Text style={{ color: colors.subtle, fontSize: 13 }}>{o.help}</Text> : null}
        <ActionSheet visible={open} title={o.label} options={o.choices.map((c) => ({ id: c.value, label: c.label, selected: c.value === (current?.value ?? "") }))}
          onClose={() => setOpen(false)} onSelect={(v) => { setOpen(false); onChange(v); }} testID={`opt-${o.name}-sheet`} />
      </View>
    );
  }
  const multiline = o.kind === "phrases";
  return (
    <Field label={o.label} value={value} onChangeText={onChange} editable={!disabled} testID={`opt-${o.name}`}
      placeholder={o.placeholder ?? (o.kind === "int" && o.default !== undefined ? String(o.default) : undefined)}
      secureTextEntry={o.kind === "password"} autoCapitalize="none" autoCorrect={false}
      keyboardType={o.kind === "int" ? "number-pad" : o.kind === "ranges" ? "numbers-and-punctuation" : "default"}
      multiline={multiline} style={multiline ? { minHeight: 110, textAlignVertical: "top" } : undefined}
      error={error} hint={o.help} />
  );
}

/**
 * From email: recent mail with attachments, then the files on the chosen message that this tool takes.
 * The tool then runs straight on the stored attachment, so nothing is uploaded from the phone.
 */
export function MailAttachmentSheet({ visible, tool, onClose, onPick }: { visible: boolean; tool: ToolDef; onClose: () => void; onPick: (a: Attachment) => void }) {
  const { api } = useSession();
  const [list, setList] = useState<MessageSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ m: MessageSummary; files: Attachment[] | null } | null>(null);
  useEffect(() => {
    if (!visible) return;
    let gone = false;
    // The inbox and the archive, newest first: a file often sits in mail already dealt with.
    Promise.all([api.messages({ folder: "inbox", limit: 50 }), api.messages({ folder: "archive", limit: 50 }).catch(() => ({ messages: [] as MessageSummary[] }))])
      .then(([a, b]) => {
        if (gone) return;
        setError(null);
        setList([...a.messages, ...b.messages].filter((m) => m.hasAttachments).sort((x, y) => String(y.date).localeCompare(String(x.date))));
      })
      .catch((e: Error) => { if (!gone) setError(e.message || "Couldn't load your email."); });
    return () => { gone = true; };
  }, [visible, api]);
  const close = () => { setOpen(null); onClose(); };
  const choose = async (m: MessageSummary) => {
    setOpen({ m, files: null });
    try {
      const t = await api.message(m.id);
      const msg = t.thread.find((x) => x.id === m.id) ?? t.message;
      setOpen({ m, files: (msg?.attachments ?? []).filter((a) => a.available !== false && toolTakes(tool, a.filename, a.contentType)) });
    } catch { setOpen({ m, files: [] }); }
  };
  const options = open
    ? (open.files ?? []).map((a) => ({ id: a.id, label: middleTruncate(a.filename, 34), hint: sizeLabel(a.sizeBytes), icon: "paperclip" as IconName }))
    : (list ?? []).slice(0, 30).map((m) => ({ id: m.id, label: m.subject || "(no subject)", hint: m.from?.name || m.from?.address, icon: "mail" as IconName }));
  return (
    <ActionSheet visible={visible} testID="tool-mail-sheet" title={open ? "Choose a file" : "From your email"}
      subtitle={open ? open.m.subject || undefined : `Recent emails with ${tool.acceptLabel}`}
      options={options}
      onClose={close}
      onSelect={(id) => {
        if (!open) { const m = list?.find((x) => x.id === id); if (m) void choose(m); return; }
        const a = open.files?.find((x) => x.id === id);
        if (a) { setOpen(null); onPick(a); }
      }}>
      {open && open.files === null ? <ActivityIndicator style={{ marginVertical: space.lg }} color={colors.brand} /> : null}
      {!open && list === null && !error ? <ActivityIndicator style={{ marginVertical: space.lg }} color={colors.brand} /> : null}
      {error ? <Text style={{ color: colors.bad, fontSize: 14, paddingHorizontal: space.lg }}>{error}</Text> : null}
      {!open && list && !list.length ? <Text style={{ color: colors.subtle, fontSize: 14, paddingHorizontal: space.lg, paddingBottom: space.sm }}>No recent email in your inbox or archive has an attachment.</Text> : null}
      {open && open.files && !open.files.length ? <Text style={{ color: colors.subtle, fontSize: 14, paddingHorizontal: space.lg, paddingBottom: space.sm }}>{`This email has no file this tool takes. It takes ${tool.acceptLabel}.`}</Text> : null}
      {open ? (
        <Pressable onPress={() => setOpen(null)} accessibilityRole="button" accessibilityLabel="Back to your emails" testID="tool-mail-back"
          style={{ minHeight: TOUCH, justifyContent: "center", paddingHorizontal: space.lg }}>
          <Text style={{ color: colors.brand, fontSize: 15, fontWeight: "600" }}>Back to your emails</Text>
        </Pressable>
      ) : null}
    </ActionSheet>
  );
}
