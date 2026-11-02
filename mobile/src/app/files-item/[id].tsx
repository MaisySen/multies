import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Badge, Button, EmptyState, Icon, Loading } from "@/components/ui";
import { InsetGroup } from "@/components/grouped";
import { NameSheet } from "@/components/drive";
import { colors, font, radius, space, TOUCH } from "@/theme";
import {
  canEditTags, dateLabel, driveError, DRIVE_LIMITS, itemIcon, parseTags, phonePreviewsImage, sizeLabel, VIEW_LABEL, VIEW_OF_SPACE, type DriveVersion,
} from "@/lib/drive";
import { useDriveActions, useDriveDetail, useDriveIo, useFilesAccess } from "@/lib/drive-queries";
import { openDriveFile, pickForDrive } from "@/lib/drive-files";

/**
 * M1: one file or folder. Open, rename, star, trash or restore; versions with Restore and Upload a new version (the last 20
 * are kept, as on the web); a note; tags on the Brand library (admins change them). Sharing is changed on the web.
 */
export default function FileDetail() {
  const { id, trashed } = useLocalSearchParams<{ id: string; trashed?: string }>();
  const access = useFilesAccess();
  const q = useDriveDetail(access.on ? id : null, trashed === "1");
  const act = useDriveActions();
  const io = useDriveIo();
  const [edit, setEdit] = useState<"name" | "note" | "tags" | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pct, setPct] = useState<number | null>(null);

  if (access.pending || (access.on && q.isPending)) return <Loading label="Loading file" rows={5} />;
  if (!access.on || q.error) {
    const e = q.error ? driveError(q.error) : { noAccess: true, message: "", offline: false, off: false };
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }} testID="file-detail-error">
        <Stack.Screen options={{ title: "File" }} />
        {e.noAccess || e.off ? <EmptyState icon="lock" title="You can't open this file" body="It may have moved, gone to the trash, or not be shared with you." />
          : <EmptyState icon={e.offline ? "wifi-off" : "alert-circle"} title="Couldn't load this file" body={e.message} action={<Button label="Try again" variant="secondary" onPress={() => q.refetch()} />} />}
      </View>
    );
  }
  const { item, versions, shares } = q.data!;
  const inTrash = !!item.trashedAt;
  const where = item.location ?? VIEW_LABEL[VIEW_OF_SPACE[item.space]];
  const fail = (t: string) => (e: unknown) => Alert.alert(t, driveError(e).message);
  const save = (kind: "name" | "note" | "tags", v: string) => {
    const done = { onSuccess: () => { setEdit(null); setEditError(null); }, onError: (e: unknown) => setEditError(driveError(e).message) };
    if (kind === "name") act.rename.mutate({ id: item.id, name: v }, done);
    else if (kind === "note") act.setNote.mutate({ id: item.id, note: v.trim() ? v.trim().slice(0, DRIVE_LIMITS.note) : null }, done);
    else act.setTags.mutate({ id: item.id, tags: parseTags(v) }, done);
  };
  const open = async (v?: DriveVersion) => {
    if (!v && phonePreviewsImage(item)) { router.push({ pathname: "/files-preview/[id]", params: { id: item.id, name: item.name } }); return; }
    if (!io.auth) { Alert.alert("Open on your phone", "Files open in the app on a phone signed in to Multies."); return; }
    setBusy(v ? v.id : "open");
    try { await openDriveFile(io, item, v && !v.current ? v.id : undefined); } catch (e) { fail("Couldn't open this file")(e); } finally { setBusy(null); }
  };
  const newVersion = async () => {
    let files;
    try { files = await pickForDrive(undefined, false); } catch { return; }
    if (!files[0]) return;
    setPct(0);
    act.newVersion.mutate({ id: item.id, file: files[0], onProgress: (f) => setPct(Math.round(f * 100)) }, { onSettled: () => setPct(null), onError: fail("Couldn't upload the new version") });
  };
  const restoreVersion = (v: DriveVersion) => Alert.alert(`Restore version ${v.number}?`, "It becomes the newest version. The others stay in the list.", [
    { text: "Cancel", style: "cancel" },
    { text: "Restore", onPress: () => act.restoreVersion.mutate({ id: item.id, vid: v.id }, { onError: fail("Couldn't restore that version") }) },
  ]);
  const toTrash = () => Alert.alert(`Move ${item.name} to the trash?`, `You can restore it for ${DRIVE_LIMITS.trashDays} days.`, [
    { text: "Cancel", style: "cancel" },
    { text: "Move to trash", style: "destructive", onPress: () => act.trash.mutate([item.id], { onSuccess: () => router.back(), onError: fail("Couldn't move to the trash") }) },
  ]);
  const restore = () => act.restore.mutate([item.id], { onSuccess: () => router.back(), onError: fail("Couldn't restore") });
  const tagsEditable = canEditTags(item, access.admin);

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: space.xxl * 2, gap: space.xl }} testID="file-detail"
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { void q.refetch(); }} />}>
      <Stack.Screen options={{ title: item.kind === "folder" ? "Folder" : "File" }} />
      <View style={{ alignItems: "center", gap: space.sm, paddingTop: space.lg, paddingHorizontal: space.lg }}>
        <View style={{ width: 64, height: 64, borderRadius: radius.lg, alignItems: "center", justifyContent: "center", backgroundColor: item.kind === "folder" ? colors.brandSoft : colors.neutralSoft }}>
          <Icon name={itemIcon(item)} size={30} color={item.kind === "folder" ? colors.brand : colors.muted} />
        </View>
        <Text style={[font.heading, { textAlign: "center" }]} accessibilityRole="header" testID="file-detail-name">{item.name}</Text>
        <Text style={{ color: colors.subtle, fontSize: 14, textAlign: "center" }}>
          {[item.kind === "file" ? sizeLabel(item.sizeBytes) : null, `Changed ${dateLabel(item.updatedAt)}`, where].filter(Boolean).join(" · ")}
        </Text>
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
          {item.starred ? <Badge label="Starred" tone="warn" icon="star" /> : null}
          {item.shared ? <Badge label="Shared" tone="brand" icon="users" /> : null}
          {inTrash ? <Badge label="In the trash" tone="bad" icon="trash-2" /> : null}
          {!item.canEdit ? <Badge label="View only" tone="neutral" icon="eye" /> : null}
        </View>
      </View>

      <View style={{ flexDirection: "row", gap: space.sm, paddingHorizontal: space.lg }}>
        {inTrash ? <Button label="Restore" icon="undo" onPress={restore} loading={act.restore.isPending} style={{ flex: 1 }} testID="file-restore" /> : (
          <>
            {item.kind === "folder"
              ? <Button label="Open folder" icon="arrow-right" onPress={() => router.push({ pathname: "/files", params: { view: VIEW_OF_SPACE[item.space], folder: item.id } })} style={{ flex: 1 }} testID="file-open" />
              : <Button label={phonePreviewsImage(item) ? "Preview" : "Open"} icon={phonePreviewsImage(item) ? "eye" : "external-link"} onPress={() => void open()} loading={busy === "open"} style={{ flex: 1 }} testID="file-open" />}
            <Button label={item.starred ? "Unstar" : "Star"} icon="star" variant="secondary" onPress={() => act.star.mutate({ ids: [item.id], on: !item.starred }, { onError: fail("Couldn't change the star") })} style={{ flex: 1 }} testID="file-star" />
          </>
        )}
      </View>

      {!inTrash && item.canEdit ? (
        <InsetGroup header="Edit">
          <DRow icon="edit-3" label="Rename" onPress={() => { setEditError(null); setEdit("name"); }} testID="file-rename" />
          {item.kind === "file" ? <DRow icon="refresh-cw" label={pct !== null ? `Uploading new version · ${pct}%` : "Upload a new version"} onPress={pct === null ? () => void newVersion() : undefined} testID="file-new-version" /> : null}
          <DRow icon="trash-2" label="Move to trash" destructive onPress={toTrash} testID="file-trash" />
        </InsetGroup>
      ) : null}

      {item.kind === "file" && versions.length ? (
        <InsetGroup header={`Versions (${versions.length})`} footer={`The last ${DRIVE_LIMITS.versions} versions are kept. Tap one to open it.`}>
          {versions.map((v) => (
            <View key={v.id} style={{ flexDirection: "row", alignItems: "center", minHeight: TOUCH + 12, paddingLeft: space.lg }} testID={`file-version-${v.number}`}>
              <Pressable onPress={() => void open(v)} accessibilityRole="button" accessibilityLabel={`Version ${v.number}, ${sizeLabel(v.sizeBytes)}, ${dateLabel(v.createdAt)} by ${v.createdBy}${v.current ? ", current" : ""}. Opens it`}
                style={{ flex: 1, paddingVertical: space.sm, gap: 2 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                  <Text style={{ color: colors.fg, fontSize: 16, fontWeight: "500" }}>Version {v.number}</Text>
                  {v.current ? <Badge label="Current" tone="ok" /> : null}
                  {busy === v.id ? <ActivityIndicator size="small" color={colors.subtle} /> : null}
                </View>
                <Text style={{ color: colors.subtle, fontSize: 13 }} numberOfLines={2}>{[sizeLabel(v.sizeBytes), dateLabel(v.createdAt), v.createdBy, v.note].filter(Boolean).join(" · ")}</Text>
              </Pressable>
              {!v.current && item.canEdit && !inTrash ? (
                <Pressable onPress={() => restoreVersion(v)} accessibilityRole="button" accessibilityLabel={`Restore version ${v.number}`} testID={`file-version-${v.number}-restore`}
                  style={{ minHeight: TOUCH, justifyContent: "center", paddingHorizontal: space.lg }}>
                  <Text style={{ color: colors.brand, fontSize: 15, fontWeight: "600" }}>Restore</Text>
                </Pressable>
              ) : <View style={{ width: space.lg }} />}
            </View>
          ))}
        </InsetGroup>
      ) : null}

      <InsetGroup header="Note" footer={item.canEdit && !inTrash ? `Up to ${DRIVE_LIMITS.note} characters.` : undefined}>
        <DRow icon="edit" label={item.note || (item.canEdit && !inTrash ? "Add a note" : "No note")} muted={!item.note} onPress={item.canEdit && !inTrash ? () => { setEditError(null); setEdit("note"); } : undefined} testID="file-note" />
      </InsetGroup>

      {item.space === "brand" ? (
        <InsetGroup header="Tags" footer={tagsEditable ? `Up to ${DRIVE_LIMITS.tags} tags, separated by commas.` : "Only admins can change tags."}>
          <DRow icon="tag" label={item.tags.length ? item.tags.join(", ") : tagsEditable ? "Add tags" : "No tags"} muted={!item.tags.length}
            onPress={tagsEditable && !inTrash ? () => { setEditError(null); setEdit("tags"); } : undefined} testID="file-tags" />
        </InsetGroup>
      ) : null}

      {shares.length ? (
        <InsetGroup header="Shared with" footer="Change sharing on the web.">
          {shares.map((s) => <DRow key={s.userId} icon="user" label={s.name} sub={s.role === "edit" ? "Can edit" : "Can view"} />)}
        </InsetGroup>
      ) : null}

      <NameSheet visible={edit === "name"} title="Rename" label="Name" initial={item.name} action="Save" maxLength={DRIVE_LIMITS.name} busy={act.rename.isPending} error={editError}
        onSubmit={(v) => save("name", v)} onClose={() => setEdit(null)} testID="file-rename-sheet" />
      <NameSheet visible={edit === "note"} title="Note" label="Note" initial={item.note ?? ""} action="Save" multiline maxLength={DRIVE_LIMITS.note} busy={act.setNote.isPending} error={editError}
        onSubmit={(v) => save("note", v)} onClose={() => setEdit(null)} testID="file-note-sheet" />
      <NameSheet visible={edit === "tags"} title="Tags" label="Tags, separated by commas" initial={item.tags.join(", ")} action="Save" busy={act.setTags.isPending} error={editError}
        onSubmit={(v) => save("tags", v)} onClose={() => setEdit(null)} testID="file-tags-sheet" />
    </ScrollView>
  );
}

function DRow({ icon, label, sub, onPress, destructive, muted, testID }: { icon: "edit-3" | "refresh-cw" | "trash-2" | "edit" | "tag" | "user"; label: string; sub?: string; onPress?: () => void; destructive?: boolean; muted?: boolean; testID?: string }) {
  const c = destructive ? colors.bad : muted ? colors.subtle : colors.fg;
  const body = (
    <>
      <Icon name={icon} size={19} color={destructive ? colors.bad : colors.brand} />
      <View style={{ flex: 1, paddingVertical: 11 }}>
        <Text style={{ color: c, fontSize: 16 }} numberOfLines={4}>{label}</Text>
        {sub ? <Text style={{ color: colors.subtle, fontSize: 13 }}>{sub}</Text> : null}
      </View>
      {onPress && !destructive ? <Icon name="chevron-right" size={16} color={colors.subtle} /> : null}
    </>
  );
  const style = { minHeight: TOUCH + 4, flexDirection: "row" as const, alignItems: "center" as const, gap: space.md, paddingHorizontal: space.lg };
  return onPress
    ? <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} testID={testID} style={({ pressed }) => [style, pressed && { backgroundColor: colors.hover }]}>{body}</Pressable>
    : <View style={style} testID={testID} accessible accessibilityLabel={sub ? `${label}, ${sub}` : label}>{body}</View>;
}
