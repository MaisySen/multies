/**
 * R101 Files plus (FILES_PLUS_R101): the workspace drive and brand library inside the Files page.
 * Left column: Team files, My files, Shared with me, Starred, Recent, Trash, Brand library and (when on) Mail
 * attachments. Folders, drag and drop upload and move, previews (images, PDF pages, video, audio, text), versions,
 * stars, trash with restore, bulk move, zip download (made in the browser) and sharing My files with teammates.
 * Brand library: tags, notes, download at a set width (resized in the browser), copy link. Admins edit it.
 */
import { LoadError } from "@/web/components/load-error-t1g"; // T1G (T1-8)
import { isNavP2 } from "@/web/layouts/shell-nav"; // F13 (R121 bug 3): Files sits in Docs
import { isServerLoadError, queryRetry } from "@/web/lib/load-errors-t1g";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { useDebounced } from "@/web/lib/search";
import { useConfig, useMe, useTeam } from "@/web/lib/queries";
import { officeActionLabel, officeEditPath, officeKindOf } from "@/shared/office-r113/kind"; // R113
import { cn } from "@/web/lib/cn";
import {
  IconAttachment, IconCheck, IconChevronRight, IconClock, IconClose, IconCopy, IconDownload, IconFile, IconFilePdf, IconFolder, IconFolderPlus, IconGrid, IconHistory, IconImage,
  IconList, IconMore, IconMove, IconMusic, IconPalette, IconPencilLine, IconReceipt, IconSearch, IconShare, IconStar, IconTag, IconTeam, IconTrash, IconUndo, IconUpload, IconUser, IconVideo,
} from "@/web/components/ui/icon";
import { Badge, Card, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Input, Select, Textarea } from "@/web/components/ui/input";
import { Menu, MenuItem } from "@/web/components/ui/menu";
import { Dialog } from "@/web/components/ui/dialog";
import { ConfirmDialog, PromptDialog } from "@/web/components/ui/confirm";
import { loadPdfjs } from "@/web/components/tools/pdf-thumb";
import { DocumentsView } from "./files-docs-r102";
import {
import { ScrollRow } from "@/web/components/ui/scroll-row"; // F13b
  DRIVE_LIMITS, VIEW_LABEL, isDriveView, previewKind, sizeLabel,
  type DriveDetail, type DriveItem, type DriveList, type DriveManifest, type DriveRole, type DriveSpace, type DriveUsage, type DriveView,
} from "@/shared/drive";

type View = DriveView | "mail" | "docs";
const DRIVE_NAV: { view: DriveView; icon: ReactNode }[] = [
  { view: "team", icon: <IconTeam className="h-4 w-4" /> },
  { view: "mine", icon: <IconUser className="h-4 w-4" /> },
  { view: "shared", icon: <IconShare className="h-4 w-4" /> },
  { view: "starred", icon: <IconStar className="h-4 w-4" /> },
  { view: "recent", icon: <IconClock className="h-4 w-4" /> },
  { view: "trash", icon: <IconTrash className="h-4 w-4" /> },
];
const DESCRIPTION: Record<View, string> = {
  team: "Files everyone in the workspace can open and add to.",
  mine: "Only you can see these, plus anyone you share them with.",
  shared: "Files and folders teammates shared with you.",
  starred: "Your starred files and folders.",
  recent: "Files changed lately.",
  trash: "Items stay here for 30 days, then they are deleted for good.",
  brand: "Logos, templates and brand files for everyone. Admins keep it tidy.",
  mail: "Attachments from your mail, sorted into folders. Search finds words inside them, scans included.",
  docs: "Bills, receipts and tax papers, read for you. Check what was found and fix anything that is off.",
};
const SPACE_FOR: Partial<Record<DriveView, DriveSpace>> = { team: "team", mine: "private", brand: "brand" };
const contentUrl = (id: string, opts: { inline?: boolean; v?: string } = {}) => `/api/drive/items/${encodeURIComponent(id)}/content?${opts.inline ? "inline=1" : ""}${opts.v ? `&v=${encodeURIComponent(opts.v)}` : ""}`;
const dateOf = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

function iconFor(it: Pick<DriveItem, "kind" | "contentType" | "name">, cls = "h-4 w-4") {
  if (it.kind === "folder") return <IconFolder className={cls} />;
  const k = previewKind(it.contentType, it.name);
  if (k === "image") return <IconImage className={cls} />;
  if (k === "pdf") return <IconFilePdf className={cls} />;
  if (k === "video") return <IconVideo className={cls} />;
  if (k === "audio") return <IconMusic className={cls} />;
  return <IconFile className={cls} />;
}

/** One upload with progress (fetch has no upload progress). */
export function sendFile(url: string, file: Blob, onPct: (n: number) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.withCredentials = true;
    xhr.setRequestHeader("x-multies-upload", "1");
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onPct(Math.round((e.loaded / e.total) * 100)); };
    xhr.onerror = () => reject(new Error("Couldn't reach Multies. Check your connection and try again."));
    xhr.onload = () => {
      let body: { error?: { message?: string } } | null = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body?.error?.message ?? "That upload didn't work. Try again."));
    };
    xhr.send(file);
  });
}

interface Upload { id: number; name: string; pct: number; error?: string; done?: boolean }

export function DrivePage({ attachments, mailOn, docsOn = false }: { attachments: ReactNode; mailOn: boolean; docsOn?: boolean }) {
  const [params, setParams] = useSearchParams();
  const asked = params.get("view");
  const view: View = asked === "mail" && mailOn ? "mail" : asked === "docs" && docsOn ? "docs" : isDriveView(asked) ? asked : "team";
  const isDrive = view !== "mail" && view !== "docs";
  const folderId = params.get("in");
  const openId = params.get("open");
  const qc = useQueryClient();
  const me = useMe();
  const isAdmin = me.data?.organization?.role === "owner" || me.data?.organization?.role === "admin";
  const [raw, setRaw] = useState("");
  const q = useDebounced(raw.trim(), 250);
  const [layout, setLayout] = useState<"list" | "grid">("list");
  const [tag, setTag] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [newFolder, setNewFolder] = useState(false);
  const [renaming, setRenaming] = useState<DriveItem | null>(null);
  const [moving, setMoving] = useState<string[] | null>(null);
  const [trashing, setTrashing] = useState<DriveItem[] | null>(null);
  const [deleting, setDeleting] = useState<DriveItem[] | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const dragDepth = useRef(0);

  useEffect(() => { setSelected(new Set()); setRaw(""); setTag(null); }, [view, folderId]);
  useEffect(() => { setLayout(view === "brand" ? "grid" : "list"); }, [view]);

  const go = useCallback((next: { view?: View; in?: string | null; open?: string | null }) => {
    setParams((p) => {
      const n = new URLSearchParams();
      const v = next.view ?? (p.get("view") as View | null) ?? "team";
      n.set("view", v);
      const inn = next.in === undefined ? (next.view ? null : p.get("in")) : next.in;
      if (inn) n.set("in", inn);
      const open = next.open === undefined ? (next.view || next.in !== undefined ? null : p.get("open")) : next.open;
      if (open) n.set("open", open);
      return n;
    });
  }, [setParams]);

  const list = useInfiniteQuery({
    queryKey: ["drive", "list", view, folderId ?? "", q],
    enabled: isDrive,
    initialPageParam: "0",
    placeholderData: keepPreviousData,
    queryFn: ({ pageParam }) => api.get<DriveList>(`/drive/list?view=${view}${folderId ? `&folder=${encodeURIComponent(folderId)}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}&cursor=${pageParam}`),
    getNextPageParam: (last) => last.next ?? undefined,
    retry: queryRetry, // T1G: never retries a 404; a server failure shows Retry in seconds
  });
  const usage = useQuery({ queryKey: ["drive", "usage"], enabled: isDrive, queryFn: () => api.get<DriveUsage>("/drive/usage"), staleTime: 60_000 });
  const tags = useQuery({ queryKey: ["drive", "tags"], enabled: view === "brand", queryFn: () => api.get<{ tags: { tag: string; count: number }[] }>("/drive/tags") });
  const first = list.data?.pages[0];
  const allItems = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const items = useMemo(() => (tag ? allItems.filter((i) => i.tags.includes(tag)) : allItems), [allItems, tag]);
  const canAdd = !!first?.canAdd && view !== "trash";
  const space: DriveSpace = (first?.folder ? (allItems[0]?.space ?? SPACE_FOR[view as DriveView]) : SPACE_FOR[view as DriveView]) ?? "team";
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["drive"] }); };

  const upload = useCallback(async (files: File[], into?: string | null) => {
    if (!canAdd && !into) { toast.error(view === "brand" ? "Only admins can add to the brand library." : "You can't add files here."); return; }
    for (const file of files) {
      const id = Date.now() + Math.random();
      if (file.size > DRIVE_LIMITS.fileBytes) { setUploads((u) => [...u, { id, name: file.name, pct: 0, error: `Bigger than ${Math.round(DRIVE_LIMITS.fileBytes / (1024 * 1024))} MB` }]); continue; }
      setUploads((u) => [...u, { id, name: file.name, pct: 0 }]);
      const qs = new URLSearchParams({ space: SPACE_FOR[view as DriveView] ?? "team", name: file.name });
      const parent = into ?? folderId;
      if (parent) qs.set("parent", parent);
      try {
        const r = await sendFile(`/api/drive/upload?${qs}`, file, (pct) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, pct } : x))));
        const name = (r as { item?: DriveItem })?.item?.name;
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, pct: 100, done: true, name: name ?? x.name } : x)));
        if (name && name !== file.name) toast(`Saved as ${name}, a file with that name is already here.`);
      } catch (e) {
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, error: (e as Error).message } : x)));
      }
    }
    refresh();
    setTimeout(() => setUploads((u) => u.filter((x) => !x.done)), 4000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAdd, view, folderId]);

  const act = useMutation({
    mutationFn: async ({ path, body }: { path: string; body: unknown; ok?: string }) => api.post(path, body),
    onSuccess: (_r, v) => { if (v.ok) toast.success(v.ok); setSelected(new Set()); refresh(); },
    onError: (e) => showError(e),
  });
  const star = (ids: string[], on: boolean) => act.mutate({ path: "/drive/star", body: { ids, on }, ok: on ? "Starred" : "Removed from starred" });
  const restore = (ids: string[]) => act.mutate({ path: "/drive/restore", body: { ids }, ok: ids.length === 1 ? "Restored" : `${ids.length} items restored` });

  const zip = async (ids: string[], name: string) => {
    const t = toast.loading("Getting your files ready");
    try {
      const m = await api.get<DriveManifest>(`/drive/manifest?ids=${ids.map(encodeURIComponent).join(",")}`);
      if (!m.files.length) { toast.error("There are no files in that selection.", { id: t }); return; }
      const { zipSync } = await import("fflate");
      const entries: Record<string, [Uint8Array, { level: 0 }]> = {};
      let n = 0;
      for (const f of m.files) {
        const res = await fetch(contentUrl(f.id), { credentials: "same-origin" });
        if (!res.ok) throw new Error(`Couldn't read ${f.path}.`);
        entries[f.path] = [new Uint8Array(await res.arrayBuffer()), { level: 0 }];
        n++;
        toast.loading(`Adding files ${n} of ${m.files.length}`, { id: t });
      }
      const out = zipSync(entries);
      const url = URL.createObjectURL(new Blob([out as BlobPart], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url; a.download = `${name}.zip`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.success(`Zip ready, ${m.files.length} ${m.files.length === 1 ? "file" : "files"}`, { id: t });
    } catch (e) { toast.error((e as Error).message || "The zip didn't work. Try again.", { id: t }); }
  };

  // Keyboard: U uploads, Shift+N makes a folder, Escape clears the selection.
  useEffect(() => {
    if (!isDrive) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "u" && canAdd) { e.preventDefault(); fileInput.current?.click(); }
      else if (e.key === "N" && e.shiftKey && canAdd && view !== "brand") { e.preventDefault(); setNewFolder(true); }
      else if (e.key === "Escape" && selected.size) setSelected(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, canAdd, selected.size, isDrive]);

  const onDragEnter = (e: DragEvent) => { if (!e.dataTransfer.types.includes("Files")) return; e.preventDefault(); dragDepth.current++; setDragging(true); };
  const onDragLeave = () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); };
  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault(); dragDepth.current = 0; setDragging(false);
    void upload([...e.dataTransfer.files]);
  };
  const moveDrop = (target: string | null) => (e: DragEvent) => {
    const ids = e.dataTransfer.getData("application/x-multies-drive");
    if (!ids) return;
    e.preventDefault(); e.stopPropagation();
    const list = ids.split(",").filter((x) => x && x !== target);
    if (list.length) act.mutate({ path: "/drive/move", body: { ids: list, parentId: target, space }, ok: list.length === 1 ? "Moved" : `${list.length} items moved` });
  };

  const selItems = items.filter((i) => selected.has(i.id));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const openItem = (it: DriveItem) => { if (view === "trash") { go({ open: it.id }); return; } if (it.kind === "folder") go({ in: it.id }); else go({ open: it.id }); };

  const title = view === "mail" ? "Mail attachments" : view === "docs" ? "Documents" : first?.folder?.name ?? VIEW_LABEL[view];
  const header = (
    <PageHeader eyebrow={isNavP2() ? "Docs" : "Tools"} title="Files" description={DESCRIPTION[view]}
      actions={canAdd && isDrive ? (
        <div className="flex gap-2">
          {view !== "brand" && <Button variant="secondary" size="sm" onClick={() => setNewFolder(true)} data-testid="drive-new-folder"><IconFolderPlus className="h-4 w-4" />New folder</Button>}
          <Button size="sm" onClick={() => fileInput.current?.click()} data-testid="drive-upload"><IconUpload className="h-4 w-4" />Upload</Button>
        </div>
      ) : undefined} />
  );

  return (
    <div className="w-full" data-testid="files-page">
      {header}
      <input ref={fileInput} type="file" multiple hidden data-testid="drive-file-input" onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ""; if (f.length) void upload(f); }} />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
        <ScrollRow as="nav" aria-label="Files" activeKey={view} className="flex gap-1.5 pb-1 md:flex-col md:overflow-visible md:pb-0 md:[mask-image:none] md:[-webkit-mask-image:none]">
          <p className="hidden px-3 pb-1 text-xs font-medium text-subtle md:block">Drive</p>
          {DRIVE_NAV.map((n) => <NavButton key={n.view} active={view === n.view} onClick={() => go({ view: n.view })} icon={n.icon} label={VIEW_LABEL[n.view]} testId={`drive-nav-${n.view}`} />)}
          <p className="hidden px-3 pb-1 pt-3 text-xs font-medium text-subtle md:block">Library</p>
          <NavButton active={view === "brand"} onClick={() => go({ view: "brand" })} icon={<IconPalette className="h-4 w-4" />} label={VIEW_LABEL.brand} testId="drive-nav-brand" />
          {mailOn && <NavButton active={view === "mail"} onClick={() => go({ view: "mail" })} icon={<IconAttachment className="h-4 w-4" />} label="Mail attachments" testId="drive-nav-mail" />}
          {docsOn && <NavButton active={view === "docs"} onClick={() => go({ view: "docs" })} icon={<IconReceipt className="h-4 w-4" />} label="Documents" testId="drive-nav-docs" />}
          {usage.data && isDrive && (
            <div className="hidden px-3 pt-4 md:block" data-testid="drive-usage">
              <div className="h-1.5 overflow-hidden rounded-full bg-fill" role="progressbar" aria-label="Files storage used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((usage.data.usedBytes / usage.data.quotaBytes) * 100)}>
                <div className="h-full rounded-full bg-brand" style={{ width: `${Math.min(100, (usage.data.usedBytes / usage.data.quotaBytes) * 100)}%` }} />
              </div>
              <p className="mt-1.5 text-xs text-subtle">{sizeLabel(usage.data.usedBytes)} of {sizeLabel(usage.data.quotaBytes)} used</p>
            </div>
          )}
        </ScrollRow>

        {view === "mail" ? <div className="min-w-0">{attachments}</div> : view === "docs" ? <DocumentsView isAdmin={isAdmin} /> : (
          <Card className="relative min-w-0 overflow-hidden" onDragEnter={onDragEnter} onDragOver={(e: DragEvent) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }} onDragLeave={onDragLeave} onDrop={onDrop} data-testid="drive-card">
            <div className="flex flex-col gap-2 border-b border-line px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <Breadcrumbs path={first?.path ?? [{ id: null, name: VIEW_LABEL[view] }]} view={first?.view ?? view} onGo={(id) => go({ in: id })} onDrop={moveDrop} />
              <div className="flex items-center gap-2">
                <div className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
                  <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
                  <Input value={raw} onChange={(e) => setRaw(e.target.value)} placeholder={`Search ${title.toLowerCase() === title ? title : title.charAt(0).toLowerCase() + title.slice(1)}`} aria-label="Search files" className="h-8 pl-8 text-[13px]" data-testid="drive-search" />
                </div>
                <div className="flex rounded-lg border border-line p-0.5" role="group" aria-label="Layout">
                  <button type="button" aria-pressed={layout === "list"} aria-label="List" onClick={() => setLayout("list")} className={cn("grid h-7 w-7 place-items-center rounded-md max-sm:h-10 max-sm:w-10", layout === "list" ? "bg-fill text-fg" : "text-muted hover:text-fg")}><IconList className="h-4 w-4" /></button>
                  <button type="button" aria-pressed={layout === "grid"} aria-label="Grid" onClick={() => setLayout("grid")} className={cn("grid h-7 w-7 place-items-center rounded-md max-sm:h-10 max-sm:w-10", layout === "grid" ? "bg-fill text-fg" : "text-muted hover:text-fg")}><IconGrid className="h-4 w-4" /></button>
                </div>
              </div>
            </div>
            {view === "brand" && !!tags.data?.tags.length && (
              <div className="flex gap-1.5 overflow-x-auto border-b border-line px-4 py-2" role="group" aria-label="Filter by tag" data-testid="drive-tags">
                <TagChip active={!tag} onClick={() => setTag(null)}>All</TagChip>
                {tags.data.tags.map((t) => <TagChip key={t.tag} active={tag === t.tag} onClick={() => setTag(tag === t.tag ? null : t.tag)}>{t.tag} <span className="tabular-nums text-subtle">{t.count}</span></TagChip>)}
              </div>
            )}
            {list.isPending ? (
              <div className="space-y-3 p-4" aria-busy="true">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-11 w-full" />)}</div>
            ) : list.isError && isServerLoadError(list.error) && !list.data ? (
              <LoadError onRetry={() => list.refetch()} />
            ) : list.isError && !isServerLoadError(list.error) ? (
              (list.error as { status?: number }).status !== 404 ? <LoadError onRetry={() => list.refetch()} /> : <EmptyState icon={<IconFolder />} title="You can't open this folder"
                body="It may have moved, gone to the trash, or not be shared with you."
                action={<Button size="sm" variant="secondary" onClick={() => go({ view: "team" })}>Go to team files</Button>} />
            ) : items.length === 0 ? (
              <DriveEmpty view={view} q={q} tag={tag} inFolder={!!first?.folder} canAdd={canAdd} isAdmin={isAdmin} onUpload={() => fileInput.current?.click()} onFolder={() => setNewFolder(true)} />
            ) : (
              <ul ref={listRef} className={cn(layout === "grid" ? "grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-4" : "divide-y divide-line")} data-testid="drive-list" aria-label={title}>
                {items.map((it) => (
                  <DriveRow key={it.id} it={it} layout={layout} view={view} selected={selected.has(it.id)} anySelected={selected.size > 0}
                    onToggle={() => toggle(it.id)} onOpen={() => openItem(it)} onStar={() => star([it.id], !it.starred)}
                    onRename={() => setRenaming(it)} onMove={() => setMoving([it.id])} onShare={() => setSharing(it.id)} onTrash={() => setTrashing([it])}
                    onRestore={() => restore([it.id])} onDelete={() => setDeleting([it])} onZip={() => void zip([it.id], it.name)}
                    onDropInto={it.kind === "folder" && it.canEdit && view !== "trash" ? moveDrop(it.id) : undefined}
                    dragIds={() => (selected.has(it.id) ? [...selected] : [it.id])} listRef={listRef} />
                ))}
              </ul>
            )}
            {list.hasNextPage && (
              <div className="border-t border-line p-3 text-center">
                <button type="button" className="text-sm text-brand-hover hover:underline max-sm:min-h-11" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>Show more</button>
              </div>
            )}
            {dragging && canAdd && (
              <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-[inherit] border-2 border-dashed border-brand bg-surface/90 transition-opacity duration-150" data-testid="drive-drop">
                <div className="text-center"><IconUpload className="mx-auto h-6 w-6 text-brand" /><p className="mt-2 text-sm font-medium">Drop to upload to {title}</p></div>
              </div>
            )}
            {selected.size > 0 && (
              <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-1.5 border-t border-line bg-surface px-3 py-2 max-md:bottom-16" data-testid="drive-bulk" role="toolbar" aria-label="Selected items">
                <span className="mr-1 text-[13px] font-medium">{selected.size} selected</span>
                {view === "trash" ? (<>
                  <Button size="sm" variant="secondary" onClick={() => restore([...selected])}><IconUndo className="h-4 w-4" />Restore</Button>
                  <Button size="sm" variant="danger" onClick={() => setDeleting(selItems)}><IconTrash className="h-4 w-4" />Delete forever</Button>
                </>) : (<>
                  {selItems.every((i) => i.canEdit) && <Button size="sm" variant="secondary" onClick={() => setMoving([...selected])}><IconMove className="h-4 w-4" />Move</Button>}
                  <Button size="sm" variant="secondary" onClick={() => void zip([...selected], first?.folder?.name ?? "Files")} data-testid="drive-bulk-zip"><IconDownload className="h-4 w-4" />Download zip</Button>
                  <Button size="sm" variant="secondary" onClick={() => star([...selected], !selItems.every((i) => i.starred))}><IconStar className="h-4 w-4" />{selItems.every((i) => i.starred) ? "Unstar" : "Star"}</Button>
                  {selItems.every((i) => i.canEdit) && <Button size="sm" variant="danger" onClick={() => setTrashing(selItems)}><IconTrash className="h-4 w-4" />Move to trash</Button>}
                </>)}
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} className="ml-auto">Clear</Button>
              </div>
            )}
          </Card>
        )}
      </div>

      {uploads.length > 0 && <UploadTray uploads={uploads} onClose={() => setUploads([])} />}
      {openId && isDrive && <PreviewPanel id={openId} trashed={view === "trash"} onClose={() => go({ open: null })} onShare={() => setSharing(openId)} isAdmin={isAdmin} onChanged={refresh} />}
      <PromptDialog open={newFolder} onClose={() => setNewFolder(false)} title="New folder" label="Folder name" confirmLabel="Create" placeholder="Untitled folder"
        validate={(v) => (v.trim() ? null : "Give the folder a name.")}
        onSubmit={(name) => { setNewFolder(false); void api.post("/drive/folders", { space: SPACE_FOR[view as DriveView] ?? "team", parentId: folderId, name }).then(() => { toast.success("Folder created"); refresh(); }, showError); }} />
      <PromptDialog open={!!renaming} onClose={() => setRenaming(null)} title={renaming?.kind === "folder" ? "Rename folder" : "Rename file"} label="Name" initial={renaming?.name ?? ""} confirmLabel="Rename"
        validate={(v) => (v.trim() ? null : "Give it a name.")}
        onSubmit={(name) => { const it = renaming; setRenaming(null); if (it) void api.patch(`/drive/items/${it.id}`, { name }).then(() => { toast.success("Renamed"); refresh(); }, showError); }} />
      <ConfirmDialog open={!!trashing} onClose={() => setTrashing(null)} title={trashing?.length === 1 ? `Move ${trashing[0].name} to the trash?` : `Move ${trashing?.length ?? 0} items to the trash?`}
        description="You can restore them from Trash for 30 days." confirmLabel="Move to trash"
        onConfirm={() => { const t = trashing ?? []; setTrashing(null); act.mutate({ path: "/drive/trash", body: { ids: t.map((x) => x.id) }, ok: t.length === 1 ? "Moved to trash" : `${t.length} items moved to trash` }); }} />
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} title={deleting?.length === 1 ? `Delete ${deleting[0].name} forever?` : `Delete ${deleting?.length ?? 0} items forever?`}
        description="This can't be undone. Every version goes too." confirmLabel="Delete forever"
        onConfirm={() => { const t = deleting ?? []; setDeleting(null); act.mutate({ path: "/drive/delete", body: { ids: t.map((x) => x.id) }, ok: "Deleted forever" }); }} />
      {moving && <MoveDialog ids={moving} startSpace={space} isAdmin={isAdmin} onClose={() => setMoving(null)} onMove={(parentId, sp) => { const ids = moving; setMoving(null); act.mutate({ path: "/drive/move", body: { ids, parentId, space: sp }, ok: ids.length === 1 ? "Moved" : `${ids.length} items moved` }); }} />}
      {sharing && <ShareDialog id={sharing} onClose={() => setSharing(null)} onSaved={refresh} />}
    </div>
  );
}

export function NavButton({ active, onClick, icon, label, testId }: { active: boolean; onClick: () => void; icon: ReactNode; label: string; testId: string }) {
  return (
    <button type="button" onClick={onClick} aria-current={active ? "page" : undefined} data-testid={testId}
      className={cn("flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13.5px] transition-colors duration-150 max-sm:min-h-11",
        active ? "bg-brand/10 font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg")}>
      <span className={active ? "text-brand" : "text-subtle"}>{icon}</span>{label}
    </button>
  );
}

function TagChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" onClick={onClick} aria-pressed={active} className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors duration-150 max-sm:min-h-11", active ? "border-brand bg-brand/10 text-fg" : "border-line text-muted hover:bg-hover hover:text-fg")}>{children}</button>;
}

function Breadcrumbs({ path, view, onGo, onDrop }: { path: { id: string | null; name: string }[]; view: DriveView; onGo: (id: string | null) => void; onDrop: (id: string | null) => (e: DragEvent) => void }) {
  return (
    <nav aria-label="Folder path" className="flex min-w-0 items-center gap-1 overflow-x-auto text-[15px]" data-testid="drive-path">
      {path.map((c, i) => {
        const last = i === path.length - 1;
        const canDrop = view !== "shared" && view !== "trash" && view !== "starred" && view !== "recent";
        return (
          <span key={c.id ?? "root"} className="flex shrink-0 items-center gap-1">
            {i > 0 && <IconChevronRight className="h-3.5 w-3.5 text-subtle" />}
            {last ? <h2 className="truncate font-semibold" aria-current="page">{c.name}</h2> : (
              <button type="button" className="truncate rounded px-1 text-muted hover:bg-hover hover:text-fg max-sm:min-h-11" onClick={() => onGo(c.id)}
                onDragOver={canDrop ? (e) => { if (e.dataTransfer.types.includes("application/x-multies-drive")) e.preventDefault(); } : undefined} onDrop={canDrop ? onDrop(c.id) : undefined}>{c.name}</button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function DriveEmpty({ view, q, tag, inFolder, canAdd, isAdmin, onUpload, onFolder }: { view: View; q: string; tag: string | null; inFolder: boolean; canAdd: boolean; isAdmin: boolean; onUpload: () => void; onFolder: () => void }) {
  if (q || tag) return <EmptyState icon={<IconSearch />} title="Nothing matches" body={tag ? `No files tagged ${tag} here.` : `No names here have "${q}" in them.`} />;
  const actions = canAdd ? (
    <div className="flex flex-wrap justify-center gap-2">
      <Button size="sm" onClick={onUpload}><IconUpload className="h-4 w-4" />Upload</Button>
      {view !== "brand" && <Button size="sm" variant="secondary" onClick={onFolder}><IconFolderPlus className="h-4 w-4" />New folder</Button>}
    </div>
  ) : undefined;
  const map: Partial<Record<View, [ReactNode, string, string]>> = {
    team: [<IconTeam key="i" />, inFolder ? "This folder is empty" : "Share files with your team", inFolder ? "Drop files here or use Upload." : "Files you add here are open to everyone in the workspace. Use My files for your own. Drag files in from your computer."],
    mine: [<IconUser key="i" />, inFolder ? "This folder is empty" : "Your own files", inFolder ? "Drop files here or use Upload." : "Only you see what you add here, until you share it with a teammate."],
    shared: [<IconShare key="i" />, "Nothing shared with you yet", "When a teammate shares a file or folder from their My files, it shows up here."],
    starred: [<IconStar key="i" />, "No starred files", "Star the files you open often to find them here."],
    recent: [<IconClock key="i" />, "Nothing recent", "Files you and your team change show up here."],
    trash: [<IconTrash key="i" />, "Trash is empty", "Things you move to the trash wait here for 30 days."],
    brand: [<IconPalette key="i" />, inFolder ? "This folder is empty" : "Your brand library", isAdmin ? "Add logos, colours and templates so everyone uses the right ones. Tag them to make them easy to find." : "An admin can add logos, colours and templates here for everyone."],
  };
  const [icon, title, body] = map[view] ?? map.team!;
  return <EmptyState icon={icon} title={title} body={body} action={actions} />;
}

function Thumb({ it, big }: { it: DriveItem; big?: boolean }) {
  const [failed, setFailed] = useState(false);
  const img = it.kind === "file" && previewKind(it.contentType, it.name) === "image" && !failed && it.sizeBytes <= 8 * 1024 * 1024;
  if (img) return <img src={contentUrl(it.id, { inline: true })} alt="" loading="lazy" onError={() => setFailed(true)} className={cn("shrink-0 rounded-lg bg-fill object-cover", big ? "aspect-[4/3] w-full" : "h-8 w-8")} />;
  return <span className={cn("grid shrink-0 place-items-center rounded-lg bg-fill text-muted", big ? "aspect-[4/3] w-full" : "h-8 w-8")}>{iconFor(it, big ? "h-7 w-7" : "h-4 w-4")}</span>;
}

function DriveRow({ it, layout, view, selected, anySelected, onToggle, onOpen, onStar, onRename, onMove, onShare, onTrash, onRestore, onDelete, onZip, onDropInto, dragIds, listRef }: {
  it: DriveItem; layout: "list" | "grid"; view: View; selected: boolean; anySelected: boolean; onToggle: () => void; onOpen: () => void; onStar: () => void; onRename: () => void; onMove: () => void;
  onShare: () => void; onTrash: () => void; onRestore: () => void; onDelete: () => void; onZip: () => void; onDropInto?: (e: DragEvent) => void; dragIds: () => string[]; listRef: React.RefObject<HTMLUListElement | null>;
}) {
  const [over, setOver] = useState(false);
  const trash = view === "trash";
  const navigate = useNavigate(); // R113: Open in editor
  const office = useConfig().data?.officeEditR113 && it.kind === "file" ? officeKindOf(it.name) : null;
  const meta = [it.location, trash && it.trashedAt ? `Deleted ${dateOf(it.trashedAt)}` : dateOf(it.updatedAt), it.kind === "file" ? sizeLabel(it.sizeBytes) : null, trash ? null : it.createdBy.name].filter(Boolean).join(" · ");
  const onKey = (e: KeyboardEvent<HTMLLIElement>) => {
    if (e.target !== e.currentTarget) return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-drive-row]") ?? [])];
    const i = rows.indexOf(e.currentTarget);
    if (e.key === "ArrowDown" || (layout === "grid" && e.key === "ArrowRight")) { e.preventDefault(); rows[i + 1]?.focus(); }
    else if (e.key === "ArrowUp" || (layout === "grid" && e.key === "ArrowLeft")) { e.preventDefault(); rows[i - 1]?.focus(); }
    else if (e.key === "Enter") { e.preventDefault(); onOpen(); }
    else if (e.key === " ") { e.preventDefault(); onToggle(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && it.canEdit && !trash) { e.preventDefault(); onTrash(); }
    else if (e.key === "F2" && it.canEdit && !trash) { e.preventDefault(); onRename(); }
  };
  const menu = (
    <Menu label={`More for ${it.name}`} trigger={<button type="button" aria-label={`More for ${it.name}`} className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-hover hover:text-fg max-sm:h-11 max-sm:w-11"><IconMore className="h-4 w-4" /></button>}>
      {trash ? (<>
        <MenuItem icon={<IconUndo className="h-4 w-4" />} onSelect={onRestore}>Restore</MenuItem>
        {it.canDelete && <MenuItem danger icon={<IconTrash className="h-4 w-4" />} onSelect={onDelete}>Delete forever</MenuItem>}
      </>) : (<>
        <MenuItem icon={it.kind === "folder" ? <IconFolder className="h-4 w-4" /> : <IconImage className="h-4 w-4" />} onSelect={onOpen}>{it.kind === "folder" ? "Open" : "Preview"}</MenuItem>
        {office && <MenuItem icon={<IconPencilLine className="h-4 w-4" />} onSelect={() => navigate(officeEditPath(it.id))}>{officeActionLabel(office)}</MenuItem>}
        {it.kind === "file" ? <MenuItem icon={<IconDownload className="h-4 w-4" />} onSelect={() => { window.location.href = contentUrl(it.id); }}>Download</MenuItem>
          : <MenuItem icon={<IconDownload className="h-4 w-4" />} onSelect={onZip}>Download zip</MenuItem>}
        <MenuItem icon={<IconStar className="h-4 w-4" />} onSelect={onStar}>{it.starred ? "Remove star" : "Star"}</MenuItem>
        {it.canEdit && <MenuItem icon={<IconPencilLine className="h-4 w-4" />} onSelect={onRename} hint="F2">Rename</MenuItem>}
        {it.canEdit && <MenuItem icon={<IconMove className="h-4 w-4" />} onSelect={onMove}>Move to</MenuItem>}
        {it.space === "private" && it.canDelete && <MenuItem icon={<IconShare className="h-4 w-4" />} onSelect={onShare}>Share</MenuItem>}
        {it.canEdit && <MenuItem danger icon={<IconTrash className="h-4 w-4" />} onSelect={onTrash} hint="Del">Move to trash</MenuItem>}
      </>)}
    </Menu>
  );
  const check = (
    <label className={cn("grid shrink-0 cursor-pointer place-items-center max-sm:h-11 max-sm:w-8", !selected && !anySelected && "md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100")}>
      <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`Select ${it.name}`} className="h-4 w-4 accent-[var(--color-brand,currentColor)]" />
    </label>
  );
  const dragProps = !trash && it.canEdit ? {
    draggable: true,
    onDragStart: (e: DragEvent<HTMLLIElement>) => { e.dataTransfer.setData("application/x-multies-drive", dragIds().join(",")); e.dataTransfer.effectAllowed = "move"; },
  } : {};
  const dropProps = onDropInto ? {
    onDragOver: (e: DragEvent<HTMLLIElement>) => { if (e.dataTransfer.types.includes("application/x-multies-drive")) { e.preventDefault(); setOver(true); } },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent<HTMLLIElement>) => { setOver(false); onDropInto(e); },
  } : {};
  const starBtn = !trash && (
    <button type="button" onClick={onStar} aria-label={it.starred ? `Remove star from ${it.name}` : `Star ${it.name}`} aria-pressed={it.starred}
      className={cn("grid h-8 w-8 place-items-center rounded-lg hover:bg-hover max-sm:h-11 max-sm:w-11", it.starred ? "text-warn" : "text-subtle md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100")}>
      <IconStar className="h-4 w-4" filled={it.starred} />
    </button>
  );
  if (layout === "grid") {
    return (
      <li data-drive-row tabIndex={0} onKeyDown={onKey} {...dragProps} {...dropProps} data-testid="drive-row"
        className={cn("group relative flex flex-col overflow-hidden rounded-xl border bg-surface outline-none transition-[border-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-brand", selected ? "border-brand" : "border-line hover:border-line-strong", over && "ring-2 ring-brand")}>
        <button type="button" onClick={onOpen} className="block text-left" aria-label={`${it.kind === "folder" ? "Open" : "Preview"} ${it.name}`} tabIndex={-1}><Thumb it={it} big /></button>
        <div className="flex items-start gap-1 p-2.5">
          {check}
          <div className="min-w-0 flex-1">
            <button type="button" onClick={onOpen} className="line-clamp-2 block w-full break-words text-left text-[13px] font-medium text-fg hover:underline" title={it.name}>{it.name}</button>
            <p className="truncate text-xs text-subtle">{it.tags.length ? it.tags.join(", ") : meta}</p>
          </div>
          {menu}
        </div>
      </li>
    );
  }
  return (
    <li data-drive-row tabIndex={0} onKeyDown={onKey} {...dragProps} {...dropProps} data-testid="drive-row"
      className={cn("group flex items-center gap-3 px-3 py-2 outline-none transition-colors duration-150 focus-visible:bg-hover sm:px-4", selected ? "bg-brand/5" : "hover:bg-hover/60", over && "bg-brand/10 ring-1 ring-inset ring-brand")}>
      {check}
      <Thumb it={it} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <button type="button" onClick={onOpen} className="truncate text-left text-[13.5px] font-medium text-fg hover:underline max-sm:min-h-8" title={it.name}>{it.name}</button>
          {it.shared && <Badge>Shared</Badge>}
          {it.versions > 1 && <span className="text-xs text-subtle">v{it.versions}</span>}
        </div>
        <div className="truncate text-xs text-subtle">{meta}</div>
      </div>
      {starBtn}
      {menu}
    </li>
  );
}

function UploadTray({ uploads, onClose }: { uploads: Upload[]; onClose: () => void }) {
  const left = uploads.filter((u) => !u.done && !u.error).length;
  return (
    <div className="fixed bottom-4 right-4 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface shadow-lg max-md:bottom-20" role="status" aria-live="polite" data-testid="drive-uploads">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="text-[13px] font-medium">{left ? `Uploading ${left} ${left === 1 ? "file" : "files"}` : "Uploads done"}</span>
        <button type="button" onClick={onClose} aria-label="Close uploads" className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-hover max-sm:h-11 max-sm:w-11"><IconClose className="h-4 w-4" /></button>
      </div>
      <ul className="max-h-60 overflow-y-auto">
        {uploads.map((u) => (
          <li key={u.id} className="px-3 py-2">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate">{u.name}</span>
              <span className={cn("shrink-0", u.error ? "text-bad" : "text-subtle")}>{u.error ? "Failed" : u.done ? <IconCheck className="h-3.5 w-3.5 text-good" /> : `${u.pct}%`}</span>
            </div>
            {u.error ? <p className="mt-0.5 text-xs text-bad">{u.error}</p> : !u.done && <div className="mt-1 h-1 overflow-hidden rounded-full bg-fill"><div className="h-full bg-brand transition-[width] duration-150" style={{ width: `${u.pct}%` }} /></div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PreviewPanel({ id, trashed, onClose, onShare, isAdmin, onChanged }: { id: string; trashed: boolean; onClose: () => void; onShare: () => void; isAdmin: boolean; onChanged: () => void }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ["drive", "item", id], queryFn: () => api.get<DriveDetail>(`/drive/items/${encodeURIComponent(id)}${trashed ? "?trashed=1" : ""}`), retry: false });
  const [tab, setTab] = useState<"preview" | "versions" | "details">("preview");
  const versionInput = useRef<HTMLInputElement>(null);
  const [pct, setPct] = useState<number | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { setTab("preview"); }, [id]);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    panel.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const it = detail.data?.item;
  const reload = () => { void qc.invalidateQueries({ queryKey: ["drive"] }); onChanged(); };
  const newVersion = async (file: File) => {
    if (file.size > DRIVE_LIMITS.fileBytes) { toast.error(`Files can be up to ${Math.round(DRIVE_LIMITS.fileBytes / (1024 * 1024))} MB here.`); return; }
    setPct(0);
    try { await sendFile(`/api/drive/items/${encodeURIComponent(id)}/content`, file, setPct); toast.success("New version saved"); reload(); setTab("versions"); }
    catch (e) { toast.error((e as Error).message); }
    finally { setPct(null); }
  };
  const restoreV = useMutation({ mutationFn: (vid: string) => api.post(`/drive/items/${encodeURIComponent(id)}/versions/${encodeURIComponent(vid)}/restore`), onSuccess: () => { toast.success("Version restored"); reload(); }, onError: (e) => showError(e) });
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={it ? it.name : "File"} data-testid="drive-preview">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/30 motion-safe:animate-in motion-safe:fade-in" onClick={onClose} tabIndex={-1} />
      <div ref={panel} tabIndex={-1} className="relative flex h-full w-full flex-col bg-surface shadow-xl outline-none sm:w-[min(640px,92vw)] sm:border-l sm:border-line">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          {it && <span className="text-muted">{iconFor(it)}</span>}
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold" title={it?.name}>{it?.name ?? "Loading"}</h2>
          {it && it.kind === "file" && <a href={contentUrl(it.id)} aria-label={`Download ${it.name}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-muted hover:bg-hover hover:text-fg max-sm:min-h-11" data-testid="drive-download"><IconDownload className="h-4 w-4" /><span className="max-sm:hidden">Download</span></a>}
          {detail.data?.canShare && !trashed && <Button size="sm" variant="ghost" onClick={onShare} aria-label="Share"><IconShare className="h-4 w-4" /><span className="max-sm:hidden">Share</span></Button>}
          <button type="button" onClick={onClose} aria-label="Close preview" className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-hover max-sm:h-11 max-sm:w-11"><IconClose className="h-4 w-4" /></button>
        </div>
        {detail.isPending ? <div className="space-y-3 p-4"><Skeleton className="h-64 w-full" /><Skeleton className="h-6 w-1/2" /></div>
          : detail.isError || !it ? <EmptyState icon={<IconFile />} title="You can't open this file" body="It may have moved, gone to the trash, or not be shared with you." />
          : (<>
            <div className="flex gap-1 border-b border-line px-4" role="tablist">
              {(["preview", ...(it.kind === "file" ? ["versions"] : []), "details"] as const).map((t) => (
                <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t as typeof tab)} data-testid={`drive-tab-${t}`}
                  className={cn("-mb-px border-b-2 px-3 py-2.5 text-[13px] transition-colors duration-150 max-sm:min-h-11", tab === t ? "border-brand font-medium text-fg" : "border-transparent text-muted hover:text-fg")}>
                  {t === "preview" ? "Preview" : t === "versions" ? `Versions ${it.versions}` : "Details"}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {tab === "preview" && <FilePreview it={it} isAdmin={isAdmin} />}
              {tab === "versions" && (
                <div data-testid="drive-versions">
                  {it.canEdit && !trashed && (
                    <div className="mb-4 flex items-center gap-3">
                      <input ref={versionInput} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void newVersion(f); }} data-testid="drive-version-input" />
                      <Button size="sm" onClick={() => versionInput.current?.click()} disabled={pct !== null}><IconUpload className="h-4 w-4" />{pct !== null ? `Uploading ${pct}%` : "Upload new version"}</Button>
                      <span className="text-xs text-subtle">Keeps the last {DRIVE_LIMITS.versions} versions.</span>
                    </div>
                  )}
                  <ul className="divide-y divide-line rounded-xl border border-line">
                    {detail.data.versions.map((v) => (
                      <li key={v.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5" data-testid="drive-version">
                        <IconHistory className="h-4 w-4 shrink-0 text-subtle" />
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-medium">Version {v.number} {v.current && <Badge>Current</Badge>}</p>
                          <p className="truncate text-xs text-subtle">{v.createdBy} · {new Date(v.createdAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} · {sizeLabel(v.sizeBytes)}{v.note ? ` · ${v.note}` : ""}</p>
                        </div>
                        <a href={contentUrl(it.id, { v: v.id })} className="inline-flex h-8 items-center rounded-lg px-2.5 text-xs text-muted hover:bg-hover hover:text-fg max-sm:min-h-11">Download</a>
                        {!v.current && it.canEdit && !trashed && <Button size="sm" variant="secondary" onClick={() => restoreV.mutate(v.id)} disabled={restoreV.isPending}>Restore</Button>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {tab === "details" && <Details d={detail.data} onSaved={reload} />}
            </div>
          </>)}
      </div>
    </div>
  );
}

function FilePreview({ it, isAdmin }: { it: DriveItem; isAdmin: boolean }) {
  const kind = it.kind === "folder" ? "none" : previewKind(it.contentType, it.name);
  const src = contentUrl(it.id, { inline: true });
  const office = useConfig().data?.officeEditR113 && it.kind === "file" && !it.trashedAt ? officeKindOf(it.name) : null; // R113
  return (
    <div className="space-y-4">
      {office && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2.5">
          <p className="min-w-0 flex-1 text-xs text-subtle">{office === "pptx" ? "See every slide here. Nothing is changed." : it.canEdit ? "Edit it here. Saving keeps the original in Versions." : "You can view it here. Only people who can edit can save."}</p>
          <Link to={officeEditPath(it.id)} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand px-3 text-[13px] font-medium text-white transition-colors duration-150 hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 max-sm:h-11" data-testid="drive-open-editor">{officeActionLabel(office)}</Link>
        </div>
      )}
      {kind === "image" && <img src={src} alt={it.name} className="mx-auto h-[min(60vh,28rem)] w-full rounded-lg bg-fill object-contain" data-testid="drive-preview-image" />}
      {kind === "video" && <video src={src} controls preload="metadata" className="max-h-[60vh] w-full rounded-lg bg-black" data-testid="drive-preview-video"><track kind="captions" /></video>}
      {kind === "audio" && <audio src={src} controls className="w-full" data-testid="drive-preview-audio" />}
      {kind === "pdf" && <PdfPages id={it.id} size={it.sizeBytes} />}
      {kind === "text" && <TextPreview id={it.id} />}
      {/* F13b (MB-302): when the editor can open it, the box above says what to do; no "no preview" under it. */}
      {((kind === "office" && !office) || kind === "none") && (
        <div className="rounded-xl border border-line p-6 text-center" data-testid="drive-preview-none">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-fill text-muted">{iconFor(it, "h-6 w-6")}</span>
          <p className="mt-3 text-[13.5px] font-medium">{it.kind === "folder" ? "Folder" : kind === "office" ? "No preview for this office file yet" : "No preview for this kind of file"}</p>
          <p className="mt-1 text-xs text-subtle">{it.kind === "folder" ? "Open it from the list to see what is inside." : kind === "office" ? "Download it, or turn it into a PDF in Tools, Convert." : "Download it to open it on your device."}</p>
          {kind === "office" && <a href="/app/tools/convert" className="mt-3 inline-block text-[13px] text-brand-hover hover:underline">Open Convert</a>}
        </div>
      )}
      {it.space === "brand" && kind === "image" && <BrandUse it={it} />}
      {it.space === "brand" && !isAdmin && it.note && <p className="text-[13px] text-muted">{it.note}</p>}
    </div>
  );
}

function BrandUse({ it }: { it: DriveItem }) {
  const [width, setWidth] = useState("512");
  const [busy, setBusy] = useState(false);
  const link = `${window.location.origin}/app/files?view=brand&open=${encodeURIComponent(it.id)}`;
  const resized = async () => {
    setBusy(true);
    try {
      const res = await fetch(contentUrl(it.id, { inline: true }), { credentials: "same-origin" });
      const bmp = await createImageBitmap(await res.blob());
      const w = Math.min(Number(width), bmp.width), h = Math.round((bmp.height / bmp.width) * w);
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      c.getContext("2d")?.drawImage(bmp, 0, 0, w, h);
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
      if (!blob) throw new Error("x");
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${it.name.replace(/\.[^.]+$/, "")} ${w}px.png`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch { toast.error("That image couldn't be resized here. Download the original instead."); }
    finally { setBusy(false); }
  };
  return (
    <div className="rounded-xl border border-line p-3" data-testid="drive-brand-use">
      <p className="mb-2 text-[13px] font-medium">Use this asset</p>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={width} onChange={(e) => setWidth(e.target.value)} aria-label="Width" className="h-8 w-28 text-[13px]">
          {["64", "128", "256", "512", "1024", "2048"].map((w) => <option key={w} value={w}>{w} px</option>)}
        </Select>
        <Button size="sm" variant="secondary" onClick={() => void resized()} disabled={busy}><IconDownload className="h-4 w-4" />Download PNG</Button>
        <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(link).then(() => toast.success("Link copied"), () => toast.error("Couldn't copy the link."))}><IconCopy className="h-4 w-4" />Copy link</Button>
      </div>
    </div>
  );
}

function PdfPages({ id, size }: { id: string; size: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [pages, setPages] = useState(0);
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        if (size > 15 * 1024 * 1024) throw new Error("big");
        const lib = await loadPdfjs();
        const data = new Uint8Array(await (await fetch(contentUrl(id), { credentials: "same-origin" })).arrayBuffer());
        const doc = await lib.getDocument({ data, disableAutoFetch: true, stopAtErrors: false }).promise;
        if (dead) return;
        setPages(doc.numPages);
        const width = Math.min(560, box.current?.clientWidth ?? 560);
        for (let n = 1; n <= Math.min(doc.numPages, 10) && !dead; n++) {
          const page = await doc.getPage(n);
          const vp0 = page.getViewport({ scale: 1 });
          const vp = page.getViewport({ scale: (width / vp0.width) * (window.devicePixelRatio || 1) });
          const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height;
          c.style.width = "100%"; c.className = "rounded-lg border border-line bg-white"; c.setAttribute("aria-label", `Page ${n}`);
          const ctx = c.getContext("2d");
          if (!ctx) break;
          await page.render({ canvas: c, canvasContext: ctx, viewport: vp }).promise;
          box.current?.appendChild(c);
          if (n === 1) setState("ok");
        }
      } catch { if (!dead) setState("error"); }
    })();
    const el = box.current;
    return () => { dead = true; if (el) el.innerHTML = ""; };
  }, [id, size]);
  return (
    <div data-testid="drive-preview-pdf">
      {state === "loading" && <Skeleton className="aspect-[3/4] w-full" />}
      {state === "error" && <p className="rounded-xl border border-line p-6 text-center text-[13px] text-muted">This PDF can't be shown here. Download it to read it.</p>}
      <div ref={box} className="space-y-3" />
      {pages > 10 && state === "ok" && <p className="mt-3 text-center text-xs text-subtle">Showing 10 of {pages} pages. Download it to read the rest.</p>}
    </div>
  );
}

function TextPreview({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["drive", "text", id], queryFn: async () => { const r = await fetch(contentUrl(id), { credentials: "same-origin", headers: { range: "bytes=0-199999" } }); if (!r.ok) throw new Error("x"); return r.text(); } });
  if (q.isPending) return <Skeleton className="h-48 w-full" />;
  if (q.isError) return <p className="text-[13px] text-muted">This file can't be shown here. Download it to read it.</p>;
  return <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-fill p-3 text-xs leading-relaxed" data-testid="drive-preview-text">{q.data}</pre>;
}

function Details({ d, onSaved }: { d: DriveDetail; onSaved: () => void }) {
  const it = d.item;
  const [tags, setTags] = useState(it.tags.join(", "));
  const [note, setNote] = useState(it.note ?? "");
  useEffect(() => { setTags(it.tags.join(", ")); setNote(it.note ?? ""); }, [it.id, it.tags, it.note]);
  const save = useMutation({ mutationFn: () => api.patch(`/drive/items/${encodeURIComponent(it.id)}`, { tags: tags.split(",").map((t) => t.trim()).filter(Boolean), note: note.trim() || null }), onSuccess: () => { toast.success("Saved"); onSaved(); }, onError: (e) => showError(e) });
  const where = it.space === "team" ? "Team files" : it.space === "brand" ? "Brand library" : "My files";
  return (
    <div className="space-y-5" data-testid="drive-details">
      <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2 text-[13px]">
        <dt className="text-subtle">Where</dt><dd>{where}</dd>
        <dt className="text-subtle">Added by</dt><dd>{it.createdBy.name}</dd>
        <dt className="text-subtle">Changed</dt><dd>{new Date(it.updatedAt).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" })}</dd>
        {it.kind === "file" && <><dt className="text-subtle">Size</dt><dd>{sizeLabel(it.sizeBytes)}</dd><dt className="text-subtle">Type</dt><dd className="truncate">{it.contentType}</dd></>}
        {it.space === "private" && <><dt className="text-subtle">Shared with</dt><dd>{d.shares.length ? d.shares.map((s) => `${s.name} (${s.role === "edit" ? "can edit" : "can view"})`).join(", ") : "Only you"}</dd></>}
      </dl>
      {it.space === "brand" && (it.canEdit ? (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <label className="block text-[13px]"><span className="mb-1 flex items-center gap-1.5 font-medium"><IconTag className="h-3.5 w-3.5" />Tags</span>
            <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="logo, dark, social" data-testid="drive-tags-input" /><span className="mt-1 block text-xs text-subtle">Separate tags with commas. Up to {DRIVE_LIMITS.tags}.</span></label>
          <label className="block text-[13px]"><span className="mb-1 block font-medium">How to use it</span>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={DRIVE_LIMITS.note} placeholder="For example: use on dark backgrounds, keep clear space around it" /></label>
          <Button size="sm" type="submit" disabled={save.isPending}>Save</Button>
        </form>
      ) : (
        <div className="text-[13px]">
          {it.tags.length > 0 && <p className="mb-2 flex flex-wrap gap-1.5">{it.tags.map((t) => <Badge key={t}>{t}</Badge>)}</p>}
          {it.note && <p className="text-muted">{it.note}</p>}
        </div>
      ))}
    </div>
  );
}

function MoveDialog({ ids, startSpace, isAdmin, onClose, onMove }: { ids: string[]; startSpace: DriveSpace; isAdmin: boolean; onClose: () => void; onMove: (parentId: string | null, space: DriveSpace) => void }) {
  const [space, setSpace] = useState<DriveSpace>(startSpace);
  const [at, setAt] = useState<string | null>(null);
  const view: DriveView = space === "team" ? "team" : space === "private" ? "mine" : "brand";
  const q = useQuery({ queryKey: ["drive", "move", view, at ?? ""], queryFn: () => api.get<DriveList>(`/drive/list?view=${view}${at ? `&folder=${encodeURIComponent(at)}` : ""}`) });
  const folders = (q.data?.items ?? []).filter((i) => i.kind === "folder" && !ids.includes(i.id));
  const canHere = !!q.data?.canAdd || (!!q.data?.folder?.canEdit);
  const spaces: DriveSpace[] = isAdmin ? ["team", "private", "brand"] : ["team", "private"];
  return (
    <Dialog open onClose={onClose} title={ids.length === 1 ? "Move to" : `Move ${ids.length} items to`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => onMove(at, space)} disabled={!canHere} data-testid="drive-move-here">Move here</Button></>}>
      <div className="mb-3 flex gap-1.5">
        {spaces.map((s) => <TagChip key={s} active={space === s} onClick={() => { setSpace(s); setAt(null); }}>{s === "team" ? "Team files" : s === "private" ? "My files" : "Brand library"}</TagChip>)}
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-1 text-[13px]">
        {(q.data?.path ?? []).map((c, i, arr) => (
          <span key={c.id ?? "root"} className="flex items-center gap-1">
            {i > 0 && <IconChevronRight className="h-3 w-3 text-subtle" />}
            {i === arr.length - 1 ? <span className="font-medium">{c.name}</span> : <button type="button" className="text-muted hover:text-fg hover:underline max-sm:min-h-11" onClick={() => setAt(c.id)}>{c.name}</button>}
          </span>
        ))}
      </div>
      <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-xl border border-line" data-testid="drive-move-folders">
        {q.isPending ? <li className="p-3"><Skeleton className="h-6 w-full" /></li> : folders.length === 0 ? <li className="px-3 py-6 text-center text-[13px] text-subtle">No folders here</li> : folders.map((f) => (
          <li key={f.id}><button type="button" onClick={() => setAt(f.id)} className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] hover:bg-hover max-sm:min-h-11"><IconFolder className="h-4 w-4 text-subtle" /><span className="truncate">{f.name}</span><IconChevronRight className="ml-auto h-3.5 w-3.5 text-subtle" /></button></li>
        ))}
      </ul>
      {!canHere && !q.isPending && <p className="mt-2 text-xs text-subtle">You can't add to this folder.</p>}
    </Dialog>
  );
}

function ShareDialog({ id, onClose, onSaved }: { id: string; onClose: () => void; onSaved: () => void }) {
  const team = useTeam();
  const me = useMe();
  const d = useQuery({ queryKey: ["drive", "item", id], queryFn: () => api.get<DriveDetail>(`/drive/items/${encodeURIComponent(id)}`) });
  const [roles, setRoles] = useState<Record<string, DriveRole | "">>({});
  useEffect(() => { if (d.data) setRoles(Object.fromEntries(d.data.shares.map((s) => [s.userId, s.role]))); }, [d.data]);
  const people = (team.data?.members ?? []).filter((m) => m.kind === "human" && m.userId !== me.data?.user.id);
  const save = useMutation({
    mutationFn: () => api.put(`/drive/items/${encodeURIComponent(id)}/shares`, { shares: Object.entries(roles).filter(([, r]) => r).map(([userId, role]) => ({ userId, role })) }),
    onSuccess: () => { toast.success("Sharing saved"); onSaved(); onClose(); },
    onError: (e) => showError(e),
  });
  return (
    <Dialog open onClose={onClose} title={d.data ? `Share ${d.data.item.name}` : "Share"} description="Teammates you add see it under Shared with me. A shared folder shares what is in it."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || !d.data} data-testid="drive-share-save">Save</Button></>}>
      {team.isPending || d.isPending ? <Skeleton className="h-24 w-full" /> : people.length === 0 ? <p className="text-[13px] text-muted">Invite teammates first, then share with them here.</p> : (
        <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-xl border border-line" data-testid="drive-share-list">
          {people.map((p) => (
            <li key={p.userId} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1"><p className="truncate text-[13px] font-medium">{p.name}</p><p className="truncate text-xs text-subtle">{p.email}</p></div>
              <Select value={roles[p.userId] ?? ""} onChange={(e) => setRoles((r) => ({ ...r, [p.userId]: e.target.value as DriveRole | "" }))} aria-label={`Access for ${p.name}`} className="h-8 w-32 text-[13px]">
                <option value="">No access</option><option value="view">Can view</option><option value="edit">Can edit</option>
              </Select>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
