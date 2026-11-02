import { useEffect, useMemo, useState } from "react";
import { Alert, FlatList, Platform, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Banner, Button, Chip, EmptyState, Icon, Loading, Segmented } from "@/components/ui";
import { ActionSheet } from "@/components/action-sheet";
import { Crumbs, FileRow, MoveSheet, NameSheet } from "@/components/drive";
import { useOffline } from "@/lib/offline";
import { tick } from "@/lib/haptics";
import { colors, radius, space, TOUCH } from "@/theme";
import {
  addTarget, cleanName, DRIVE_LIMITS, driveError, emptyFor, isDriveView, MAIN_VIEWS, MORE_VIEWS, phonePreviewsImage, selectActions, SPACE_OF_VIEW, starTarget, trashFootnote, usageFraction, usageLine, VIEW_LABEL, zipFootnote,
  type DriveItem, type DriveSpace, type DriveView,
} from "@/lib/drive";
import { useDriveActions, useDriveIo, useDriveList, useDriveTags, useDriveUsage, useFilesAccess } from "@/lib/drive-queries";
import { openDriveFile, pickForDrive } from "@/lib/drive-files";

/**
 * M1 (1.10.9): Files on the phone, the web's R101 drive. Team files, My files, Shared with me, Starred, Recent, Trash and the
 * Brand library; folders with the path under the title; search; select to move, star, trash or restore; add from Files or
 * Photos, or a new folder. Images preview full screen; other files open in Quick Look (iPhone) or the matching app (Android).
 * Shown only when the web has Files on and the session is a workspace member; the server checks every action.
 */
export default function Files() {
  const params = useLocalSearchParams<{ view?: string; folder?: string; item?: string }>();
  const access = useFilesAccess();
  const view: DriveView = isDriveView(params.view) ? params.view : "team";
  const folder = typeof params.folder === "string" && params.folder ? params.folder : null;

  // Search and other screens open one file with /files?item=<id>.
  useEffect(() => { if (params.item && access.on) router.push({ pathname: "/files-item/[id]", params: { id: params.item } }); }, [params.item, access.on]);

  if (access.pending) return <Loading label="Loading Files" rows={6} />;
  if (!access.on) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }} testID="files-off">
        <Stack.Screen options={{ title: "Files" }} />
        <EmptyState icon="lock" title="You do not have access to this" body="Files are for people in a workspace. Ask an admin if you think you should see them." />
      </View>
    );
  }
  return <DriveScreen key={`${view}:${folder ?? ""}`} view={view} folder={folder} admin={access.admin} />;
}

function DriveScreen({ view, folder, admin }: { view: DriveView; folder: string | null; admin: boolean }) {
  const insets = useSafeAreaInsets();
  const offline = useOffline();
  const io = useDriveIo();
  const [raw, setRaw] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => { const t = setTimeout(() => setQ(raw.trim()), 300); return () => clearTimeout(t); }, [raw]);
  const list = useDriveList(view, folder, q);
  const usage = useDriveUsage(!folder);
  const tags = useDriveTags(view === "brand" && !folder);
  const act = useDriveActions();
  const [tag, setTag] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [sheet, setSheet] = useState<"add" | "folder" | "move" | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ n: number; of: number; pct: number } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const first = list.data?.pages[0];
  const all = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const items = useMemo(() => (tag ? all.filter((i) => i.tags.includes(tag)) : all), [all, tag]);
  const chosen = useMemo(() => all.filter((i) => picked.has(i.id)), [all, picked]);
  const can = selectActions(first?.view ?? view, chosen);
  const target = addTarget(first);
  const title = first?.path[first.path.length - 1]?.name ?? VIEW_LABEL[view];

  const go = (v: DriveView) => { tick(); router.replace({ pathname: "/files", params: { view: v } }); };
  const openFolder = (id: string | null) => {
    if (!id) { router.replace({ pathname: "/files", params: { view: first?.view ?? view } }); return; }
    router.push({ pathname: "/files", params: { view: first?.view ?? view, folder: id } });
  };
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const endSelect = () => { setSelecting(false); setPicked(new Set()); };
  const fail = (title0: string) => (e: unknown) => Alert.alert(title0, driveError(e).message);

  const open = async (it: DriveItem) => {
    if (selecting) { toggle(it.id); return; }
    if (it.kind === "folder") { if (!it.trashedAt) openFolder(it.id); return; }
    if (it.trashedAt) { router.push({ pathname: "/files-item/[id]", params: { id: it.id, trashed: "1" } }); return; }
    if (phonePreviewsImage(it)) { router.push({ pathname: "/files-preview/[id]", params: { id: it.id, name: it.name } }); return; }
    if (!io.auth) { router.push({ pathname: "/files-item/[id]", params: { id: it.id } }); return; }
    setOpening(it.id);
    try { await openDriveFile(io, it); } catch (e) { fail("Couldn't open this file")(e); } finally { setOpening(null); }
  };

  const addFiles = async (only?: "images") => {
    setSheet(null);
    if (!target) return;
    let files;
    try { files = await pickForDrive(only); } catch { Alert.alert("Couldn't open the picker", "Try again."); return; }
    if (!files.length) return;
    const tooBig = files.filter((f) => f.size > DRIVE_LIMITS.fileBytes);
    const ok = files.filter((f) => f.size <= DRIVE_LIMITS.fileBytes);
    const failed: string[] = tooBig.map((f) => `${f.name}: Files can be up to ${Math.round(DRIVE_LIMITS.fileBytes / (1024 * 1024))} MB here.`);
    for (let i = 0; i < ok.length; i++) {
      setUpload({ n: i + 1, of: ok.length, pct: 0 });
      try {
        await act.upload.mutateAsync({ target, file: ok[i], onProgress: (f) => setUpload({ n: i + 1, of: ok.length, pct: Math.round(f * 100) }) });
      } catch (e) {
        const m = driveError(e).message;
        failed.push(`${ok[i].name}: ${m}`);
        if ((e as { code?: string })?.code === "quota_full") break;
      }
    }
    setUpload(null);
    if (failed.length) Alert.alert(failed.length === 1 ? "One file didn't upload" : `${failed.length} files didn't upload`, failed.join("\n"));
  };

  const makeFolder = (name: string) => {
    if (!target) return;
    const clean = cleanName(name);
    if (!clean) { setFolderError("Give the folder a name."); return; }
    act.createFolder.mutate({ ...target, name: clean }, { onSuccess: () => { setSheet(null); setFolderError(null); }, onError: (e) => setFolderError(driveError(e).message) });
  };

  const doTrash = () => {
    const n = chosen.length;
    Alert.alert(n === 1 ? `Move ${chosen[0].name} to the trash?` : `Move ${n} items to the trash?`, trashFootnote(), [
      { text: "Cancel", style: "cancel" },
      { text: "Move to trash", style: "destructive", onPress: () => act.trash.mutate(chosen.map((i) => i.id), { onSuccess: endSelect, onError: fail("Couldn't move to the trash") }) },
    ]);
  };
  const doRestore = (ids = chosen.map((i) => i.id)) => act.restore.mutate(ids, { onSuccess: endSelect, onError: fail("Couldn't restore") });
  const doStar = () => act.star.mutate({ ids: chosen.map((i) => i.id), on: starTarget(chosen) }, { onSuccess: endSelect, onError: fail("Couldn't change the star") });
  const doMove = (t: { space: DriveSpace; parentId: string | null }) => act.move.mutate({ ids: chosen.map((i) => i.id), parentId: t.parentId, space: t.space }, {
    onSuccess: () => { setSheet(null); endSelect(); }, onError: fail("Couldn't move"),
  });

  const headerRight = () => (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      {all.length ? (
        <Pressable onPress={() => (selecting ? endSelect() : setSelecting(true))} accessibilityRole="button" accessibilityLabel={selecting ? "Done selecting" : "Select"} testID="files-select"
          style={{ minHeight: TOUCH, minWidth: TOUCH, justifyContent: "center", paddingHorizontal: 6 }}>
          <Text style={{ color: colors.brand, fontSize: 17, fontWeight: selecting ? "600" : "400" }}>{selecting ? "Done" : "Select"}</Text>
        </Pressable>
      ) : null}
      {target && !selecting ? (
        <Pressable onPress={() => setSheet("add")} accessibilityRole="button" accessibilityLabel="Add files or a folder" testID="files-add"
          style={{ width: TOUCH, height: TOUCH, alignItems: "center", justifyContent: "center" }}>
          <Icon name="plus" size={22} color={colors.brand} />
        </Pressable>
      ) : null}
    </View>
  );

  const err = list.error ? driveError(list.error) : null;
  const top = (
    <View style={{ gap: space.md, paddingTop: space.sm, paddingBottom: space.md }}>
      {!folder ? (
        <View style={{ paddingHorizontal: space.lg, gap: space.sm }}>
          <Segmented value={(MAIN_VIEWS as DriveView[]).includes(view) ? view : ("" as DriveView)} options={MAIN_VIEWS.map((v) => ({ id: v, label: v === "team" ? "Team" : v === "mine" ? "Mine" : "Shared" }))} onChange={go} label="Files" />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }} testID="files-more-views">
            {MORE_VIEWS.map((v) => <Chip key={v} label={VIEW_LABEL[v]} selected={view === v} onPress={() => go(v)} />)}
          </ScrollView>
        </View>
      ) : <Crumbs path={first?.path ?? []} onOpen={(c) => openFolder(c.id)} />}
      <View style={{ marginHorizontal: space.lg, flexDirection: "row", alignItems: "center", gap: space.sm, backgroundColor: colors.elevated, borderRadius: radius.md, paddingHorizontal: space.md, minHeight: 40 }}>
        <Icon name="search" size={17} color={colors.subtle} />
        <TextInput value={raw} onChangeText={setRaw} placeholder={folder ? `Search ${title}` : `Search ${VIEW_LABEL[view]}`} placeholderTextColor={colors.subtle} accessibilityLabel="Search files"
          returnKeyType="search" autoCorrect={false} maxLength={100} testID="files-search" style={{ flex: 1, color: colors.fg, fontSize: 16, paddingVertical: Platform.OS === "android" ? 4 : 8 }} />
        {raw ? (
          <Pressable onPress={() => setRaw("")} accessibilityRole="button" accessibilityLabel="Clear search" style={{ width: TOUCH - 8, height: TOUCH - 8, alignItems: "center", justifyContent: "center" }}>
            <Icon name="x" size={16} color={colors.subtle} />
          </Pressable>
        ) : null}
      </View>
      {view === "brand" && !folder && tags.data?.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm, paddingHorizontal: space.lg }} testID="files-tags">
          <Chip label="All" selected={!tag} onPress={() => setTag(null)} />
          {tags.data.map((t) => <Chip key={t.tag} label={t.tag} count={t.count} selected={tag === t.tag} onPress={() => setTag(tag === t.tag ? null : t.tag)} />)}
        </ScrollView>
      ) : null}
      {!folder && usage.data ? (
        <View style={{ marginHorizontal: space.lg, gap: 6 }} testID="files-usage" accessible accessibilityLabel={usageLine(usage.data)}>
          <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.elevated, overflow: "hidden" }}>
            <View style={{ width: `${Math.round(usageFraction(usage.data) * 100)}%`, height: 4, backgroundColor: usageFraction(usage.data) > 0.9 ? colors.bad : colors.brand }} />
          </View>
          <Text style={{ color: colors.subtle, fontSize: 13 }}>{usageLine(usage.data)}</Text>
        </View>
      ) : null}
      {offline ? <View style={{ paddingHorizontal: space.lg }}><Banner text="You're offline. Files need a connection." /></View> : null}
      {upload ? <View style={{ paddingHorizontal: space.lg }}><Banner tone="brand" icon="refresh-cw" text={`Uploading ${upload.of > 1 ? `${upload.n} of ${upload.of}` : "your file"} · ${upload.pct}%`} /></View> : null}
      {view === "brand" && !admin && !folder ? <Text style={{ color: colors.subtle, fontSize: 13, marginHorizontal: space.lg }}>Only admins can change the brand library. Everyone can open and download it.</Text> : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="files">
      <Stack.Screen options={{ title, headerRight }} />
      {list.isPending ? <>{top}<Loading label="Loading files" rows={6} /></> : err && !all.length ? (
        <ScrollView contentContainerStyle={{ flexGrow: 1 }} refreshControl={<RefreshControl refreshing={list.isRefetching} onRefresh={() => { void list.refetch(); }} />}>
          {top}
          {err.noAccess ? <EmptyState icon="lock" title="You do not have access to this" body="It may have moved, gone to the trash, or not be shared with you." />
            : err.off ? <EmptyState icon="alert-circle" title="This folder isn't here" body="It may have moved or gone to the trash." action={<Button label="Back to Team files" variant="secondary" onPress={() => go("team")} />} />
            : <EmptyState icon={err.offline ? "wifi-off" : "alert-circle"} title="Couldn't load files" body={err.message} action={<Button label="Try again" variant="secondary" onPress={() => list.refetch()} />} />}
        </ScrollView>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          ListHeaderComponent={top}
          contentContainerStyle={{ paddingBottom: (selecting ? 120 : space.xxl) + insets.bottom }}
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: colors.line, marginLeft: space.lg + 36 + space.md }} />}
          renderItem={({ item, index }) => (
            <FileRow item={item} selecting={selecting} selected={picked.has(item.id)} testID={`files-row-${index}`}
              onPress={() => { if (opening !== item.id) void open(item); }}
              onLongPress={() => { tick(); setSelecting(true); setPicked(new Set([item.id])); }}
              onStar={view === "trash" ? undefined : () => act.star.mutate({ ids: [item.id], on: !item.starred }, { onError: fail("Couldn't change the star") })}
              onInfo={() => router.push({ pathname: "/files-item/[id]", params: { id: item.id, ...(item.trashedAt ? { trashed: "1" } : {}) } })} />
          )}
          ListEmptyComponent={() => { const e = emptyFor(view, !!folder, q || tag || ""); return <EmptyState icon={view === "trash" ? "trash-2" : view === "starred" ? "star" : "layers"} title={e.title} body={e.body} />; }}
          ListFooterComponent={view === "trash" && items.length ? <Text style={{ color: colors.subtle, fontSize: 13, margin: space.lg }}>{trashFootnote()}</Text> : undefined}
          onEndReached={() => { if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage(); }}
          onEndReachedThreshold={0.4}
          refreshControl={<RefreshControl refreshing={list.isRefetching && !list.isFetchingNextPage} onRefresh={() => { void list.refetch(); void usage.refetch(); }} />}
        />
      )}

      {selecting ? (
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.line, paddingBottom: insets.bottom + space.sm, paddingTop: space.sm }} testID="files-select-bar">
          <Text style={{ color: colors.fg, fontSize: 14, fontWeight: "600", textAlign: "center" }} accessibilityLiveRegion="polite">{chosen.length ? `${chosen.length} selected` : "Choose items"}</Text>
          <View style={{ flexDirection: "row", justifyContent: "space-around" }}>
            {view === "trash" ? <BarButton icon="undo" label="Restore" disabled={!can.restore} onPress={() => doRestore()} testID="files-restore" /> : (
              <>
                <BarButton icon="move" label="Move" disabled={!can.move} onPress={() => setSheet("move")} testID="files-move" />
                <BarButton icon="star" label={chosen.length && !starTarget(chosen) ? "Unstar" : "Star"} disabled={!can.star} onPress={doStar} testID="files-star" />
                <BarButton icon="trash-2" label="Trash" disabled={!can.trash} onPress={doTrash} destructive testID="files-trash" />
              </>
            )}
          </View>
          <Text style={{ color: colors.subtle, fontSize: 12, textAlign: "center", marginHorizontal: space.lg }}>{zipFootnote()}</Text>
        </View>
      ) : null}

      <ActionSheet visible={sheet === "add"} title="Add to this folder" subtitle={`Files up to ${Math.round(DRIVE_LIMITS.fileBytes / (1024 * 1024))} MB each`} onClose={() => setSheet(null)} testID="files-add-sheet"
        options={[{ id: "files", label: "Upload from Files", icon: "paperclip" }, { id: "photos", label: "Upload photos or videos", icon: "eye" }, { id: "folder", label: "New folder", icon: "layers" }]}
        onSelect={(id) => { if (id === "folder") { setFolderError(null); setSheet("folder"); } else void addFiles(id === "photos" ? "images" : undefined); }} />
      <NameSheet visible={sheet === "folder"} title="New folder" label="Folder name" initial="" action="Create" maxLength={DRIVE_LIMITS.name} busy={act.createFolder.isPending} error={folderError}
        onSubmit={makeFolder} onClose={() => setSheet(null)} testID="files-new-folder" />
      <MoveSheet visible={sheet === "move"} count={chosen.length} admin={admin} startSpace={SPACE_OF_VIEW[first?.view ?? view] ?? (chosen[0]?.space ?? "team")} busy={act.move.isPending}
        onMove={doMove} onClose={() => setSheet(null)} />
    </View>
  );
}

function BarButton({ icon, label, onPress, disabled, destructive, testID }: { icon: "move" | "star" | "trash-2" | "undo"; label: string; onPress: () => void; disabled?: boolean; destructive?: boolean; testID?: string }) {
  const c = disabled ? colors.subtle : destructive ? colors.bad : colors.brand;
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }} testID={testID}
      style={{ minWidth: 72, minHeight: TOUCH + 8, alignItems: "center", justifyContent: "center", gap: 2, opacity: disabled ? 0.5 : 1 }}>
      <Icon name={icon} size={22} color={c} />
      <Text style={{ color: c, fontSize: 12, fontWeight: "500" }}>{label}</Text>
    </Pressable>
  );
}
