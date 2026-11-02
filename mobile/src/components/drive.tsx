import { useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Icon, Segmented } from "./ui";
import { useReduceMotion } from "@/lib/motion";
import { tick } from "@/lib/haptics";
import { colors, font, radius, space, TOUCH } from "@/theme";
import { itemIcon, rowSub, VIEW_LABEL, type DriveCrumb, type DriveItem, type DriveSpace, type DriveView } from "@/lib/drive";
import { useDriveList } from "@/lib/drive-queries";

/** M1: the pieces of the Files screens. */

export function FileRow({ item, selecting, selected, onPress, onLongPress, onStar, onInfo, testID }: {
  item: DriveItem; selecting: boolean; selected: boolean; onPress: () => void; onLongPress?: () => void; onStar?: () => void; onInfo?: () => void; testID?: string;
}) {
  const sub = rowSub(item);
  const kind = item.kind === "folder" ? "Folder" : "File";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: selected ? colors.brandSoft : colors.surface }}>
      <Pressable onPress={onPress} onLongPress={onLongPress} delayLongPress={350} testID={testID}
        accessibilityRole="button" accessibilityState={selecting ? { selected } : undefined}
        accessibilityLabel={`${kind}, ${item.name}${sub ? `, ${sub}` : ""}${item.starred ? ", starred" : ""}`}
        accessibilityHint={selecting ? "Selects or clears this item" : item.kind === "folder" ? "Opens the folder" : "Opens the file"}
        style={({ pressed }) => ({ flex: 1, minHeight: 60, flexDirection: "row", alignItems: "center", gap: space.md, paddingLeft: space.lg, paddingVertical: space.sm, backgroundColor: pressed ? colors.hover : "transparent" })}>
        {selecting ? <Icon name={selected ? "check-circle" : "circle"} size={22} color={selected ? colors.brand : colors.subtle} /> : null}
        <View style={{ width: 36, height: 36, borderRadius: radius.md, alignItems: "center", justifyContent: "center", backgroundColor: item.kind === "folder" ? colors.brandSoft : colors.neutralSoft }}>
          <Icon name={itemIcon(item)} size={19} color={item.kind === "folder" ? colors.brand : colors.muted} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: colors.fg, fontSize: 16, fontWeight: "500" }} numberOfLines={1}>{item.name}</Text>
          {sub ? <Text style={{ color: selected ? colors.muted : colors.subtle, fontSize: 13 }} numberOfLines={1}>{sub}</Text> : null}
        </View>
      </Pressable>
      {!selecting && onStar && !item.trashedAt ? (
        <Pressable onPress={() => { tick(); onStar(); }} accessibilityRole="button" accessibilityLabel={item.starred ? `Unstar ${item.name}` : `Star ${item.name}`} testID={testID ? `${testID}-star` : undefined}
          hitSlop={4} style={{ width: TOUCH, height: TOUCH, alignItems: "center", justifyContent: "center" }}>
          <Icon name="star" size={19} color={item.starred ? colors.warn : colors.subtle} filled={item.starred} />
        </Pressable>
      ) : null}
      {!selecting && onInfo ? (
        <Pressable onPress={onInfo} accessibilityRole="button" accessibilityLabel={`Details for ${item.name}`} testID={testID ? `${testID}-info` : undefined}
          style={{ width: TOUCH, height: TOUCH, alignItems: "center", justifyContent: "center", marginRight: space.xs }}>
          <Icon name="more-horizontal" size={20} color={colors.subtle} />
        </Pressable>
      ) : <View style={{ width: space.md }} />}
    </View>
  );
}

/** The folder path under the title: each step opens that folder. */
export function Crumbs({ path, onOpen }: { path: DriveCrumb[]; onOpen: (c: DriveCrumb) => void }) {
  if (path.length < 2) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: space.lg, alignItems: "center", gap: 2 }} testID="files-crumbs">
      {path.map((c, i) => {
        const last = i === path.length - 1;
        return (
          <View key={`${c.id ?? "root"}-${i}`} style={{ flexDirection: "row", alignItems: "center" }}>
            {i > 0 ? <Icon name="chevron-right" size={14} color={colors.subtle} /> : null}
            <Pressable disabled={last} onPress={() => onOpen(c)} accessibilityRole="button" accessibilityLabel={last ? `${c.name}, this folder` : `Go to ${c.name}`}
              style={{ minHeight: TOUCH, justifyContent: "center", paddingHorizontal: 6 }}>
              <Text style={{ color: last ? colors.fg : colors.brand, fontSize: 14, fontWeight: last ? "600" : "500", maxWidth: 180 }} numberOfLines={1}>{c.name}</Text>
            </Pressable>
          </View>
        );
      })}
    </ScrollView>
  );
}

/** A small sheet with one text field: new folder, rename, note. */
export function NameSheet({ visible, title, label, initial, action, multiline, maxLength, busy, error, onSubmit, onClose, testID }: {
  visible: boolean; title: string; label: string; initial: string; action: string; multiline?: boolean; maxLength?: number; busy?: boolean; error?: string | null;
  onSubmit: (v: string) => void; onClose: () => void; testID?: string;
}) {
  const reduce = useReduceMotion();
  return (
    <Modal visible={visible} transparent animationType={reduce ? "none" : "slide"} onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.35)" }} onPress={onClose} accessibilityLabel="Close" accessibilityRole="button" />
      {visible ? <NameBody title={title} label={label} initial={initial} action={action} multiline={multiline} maxLength={maxLength} busy={busy} error={error} onSubmit={onSubmit} onClose={onClose} testID={testID} /> : null}
    </Modal>
  );
}

/** Mounted each time the sheet opens, so the field starts from the current value. */
function NameBody({ title, label, initial, action, multiline, maxLength, busy, error, onSubmit, onClose, testID }: {
  title: string; label: string; initial: string; action: string; multiline?: boolean; maxLength?: number; busy?: boolean; error?: string | null;
  onSubmit: (v: string) => void; onClose: () => void; testID?: string;
}) {
  const insets = useSafeAreaInsets();
  const [v, setV] = useState(initial);
  return (
      <View testID={testID} accessibilityViewIsModal style={{ backgroundColor: colors.surface, borderTopLeftRadius: radius.lg + 4, borderTopRightRadius: radius.lg + 4, padding: space.lg, paddingBottom: insets.bottom + space.lg, gap: space.md }}>
        <Text style={font.headline} accessibilityRole="header">{title}</Text>
        <TextInput value={v} onChangeText={setV} autoFocus multiline={multiline} maxLength={maxLength} accessibilityLabel={label} placeholder={label} placeholderTextColor={colors.subtle}
          selectionColor={colors.brand} testID={testID ? `${testID}-input` : undefined} returnKeyType={multiline ? "default" : "done"} onSubmitEditing={multiline ? undefined : () => onSubmit(v)}
          style={{ minHeight: multiline ? 96 : TOUCH, borderRadius: radius.md, borderWidth: 1, borderColor: error ? colors.bad : colors.lineStrong, paddingHorizontal: space.md, paddingVertical: space.sm, color: colors.fg, fontSize: 16, textAlignVertical: multiline ? "top" : "center" }} />
        {error ? <Text style={{ color: colors.bad, fontSize: 14 }} accessibilityLiveRegion="polite">{error}</Text> : null}
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <Button label="Cancel" variant="secondary" onPress={onClose} style={{ flex: 1 }} testID={testID ? `${testID}-cancel` : undefined} />
          <Button label={action} onPress={() => onSubmit(v)} loading={busy} style={{ flex: 1 }} testID={testID ? `${testID}-save` : undefined} />
        </View>
      </View>
  );
}

/** Pick a destination folder: a space, then folders inside it. Brand library only for admins. */
export function MoveSheet({ visible, count, admin, startSpace, onMove, onClose, busy }: {
  visible: boolean; count: number; admin: boolean; startSpace: DriveSpace; onMove: (t: { space: DriveSpace; parentId: string | null }) => void; onClose: () => void; busy?: boolean;
}) {
  const reduce = useReduceMotion();
  return (
    <Modal visible={visible} transparent animationType={reduce ? "none" : "slide"} onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.35)" }} onPress={onClose} accessibilityLabel="Close" accessibilityRole="button" />
      {visible ? <MoveBody count={count} admin={admin} startSpace={startSpace} onMove={onMove} onClose={onClose} busy={busy} /> : null}
    </Modal>
  );
}

function MoveBody({ count, admin, startSpace, onMove, onClose, busy }: {
  count: number; admin: boolean; startSpace: DriveSpace; onMove: (t: { space: DriveSpace; parentId: string | null }) => void; onClose: () => void; busy?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const [space0, setSpace] = useState<DriveSpace>(startSpace);
  const [trail, setTrail] = useState<{ id: string; name: string }[]>([]);
  const view: DriveView = space0 === "private" ? "mine" : space0;
  const here = trail[trail.length - 1]?.id ?? null;
  const q = useDriveList(view, here, "");
  const folders = (q.data?.pages.flatMap((p) => p.items) ?? []).filter((i) => i.kind === "folder");
  const spaces: { id: DriveSpace; label: string }[] = [{ id: "team", label: "Team" }, { id: "private", label: "My files" }, ...(admin ? [{ id: "brand" as const, label: "Brand" }] : [])];
  const place = trail.length ? trail[trail.length - 1].name : VIEW_LABEL[view];
  return (
      <View testID="files-move-sheet" accessibilityViewIsModal style={{ backgroundColor: colors.surface, borderTopLeftRadius: radius.lg + 4, borderTopRightRadius: radius.lg + 4, paddingTop: space.lg, paddingBottom: insets.bottom + space.lg, maxHeight: "80%", gap: space.md }}>
        <Text style={[font.headline, { paddingHorizontal: space.lg }]} accessibilityRole="header">{count === 1 ? "Move 1 item" : `Move ${count} items`}</Text>
        <View style={{ paddingHorizontal: space.lg }}>
          <Segmented value={space0} options={spaces} onChange={(s) => { setSpace(s); setTrail([]); }} label="Where to" />
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: space.sm }}>
          {trail.length ? (
            <Pressable onPress={() => setTrail((t) => t.slice(0, -1))} accessibilityRole="button" accessibilityLabel="Back one folder" style={{ width: TOUCH, height: TOUCH, alignItems: "center", justifyContent: "center" }}>
              <Icon name="chevron-left" size={20} color={colors.brand} />
            </Pressable>
          ) : <View style={{ width: space.sm }} />}
          <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "600", flex: 1 }} numberOfLines={1}>{place}</Text>
        </View>
        <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ paddingBottom: space.sm }}>
          {q.isPending ? <ActivityIndicator color={colors.subtle} style={{ margin: space.lg }} /> : folders.length ? folders.map((f) => (
            <Pressable key={f.id} onPress={() => setTrail((t) => [...t, { id: f.id, name: f.name }])} accessibilityRole="button" accessibilityLabel={`Open ${f.name}`}
              style={({ pressed }) => ({ minHeight: TOUCH + 4, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, backgroundColor: pressed ? colors.hover : "transparent" })}>
              <Icon name="layers" size={18} color={colors.brand} />
              <Text style={{ color: colors.fg, fontSize: 16, flex: 1 }} numberOfLines={1}>{f.name}</Text>
              <Icon name="chevron-right" size={16} color={colors.subtle} />
            </Pressable>
          )) : <Text style={{ color: colors.subtle, fontSize: 14, paddingHorizontal: space.lg }}>No folders here.</Text>}
        </ScrollView>
        <View style={{ flexDirection: "row", gap: space.sm, paddingHorizontal: space.lg }}>
          <Button label="Cancel" variant="secondary" onPress={onClose} style={{ flex: 1 }} />
          <Button label="Move here" onPress={() => onMove({ space: space0, parentId: here })} loading={busy} style={{ flex: 1 }} testID="files-move-here" />
        </View>
      </View>
  );
}
