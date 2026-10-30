/**
 * Tools P2 (16, 17): Files. Mail attachments filed into smart folders (Invoices, Receipts, Contracts, ID
 * documents and the rest) with counts, a search inside the attachments, and per file the sender, date, a link
 * to its thread, the Tools menu and "Move to". Only the mailboxes the person can open. Shown while the
 * deployment has the folders feature (GET /api/tools features).
 */
import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { useConfig } from "@/web/lib/queries";
import { useDebounced } from "@/web/lib/search";
import { cn } from "@/web/lib/cn";
import { IconAttachment, IconChevronRight, IconFile, IconSearch } from "@/web/components/ui/icon";
import { Badge, Card, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { Input } from "@/web/components/ui/input";
import { Menu, MenuItem, MenuLabel } from "@/web/components/ui/menu";
import { AttachmentTools } from "./mail/attachment-tools";
import { ATTACHMENT_FOLDERS, ATTACHMENT_FOLDER_LABELS, isAttachmentFolder, type AttachmentFolder, type FileFolders, type FileItem } from "@/shared/attachment-folders";
import type { ToolsInfo } from "@/shared/tools";

const sizeOf = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`);
const dateOf = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });

export function FilesPage() {
  const config = useConfig();
  const tools = useQuery({ queryKey: ["tools"], enabled: !!config.data?.tools, queryFn: () => api.get<ToolsInfo>("/tools"), retry: false });
  const features = tools.data?.features ?? [];
  const [params, setParams] = useSearchParams();
  const asked = params.get("folder");
  const folder: AttachmentFolder = isAttachmentFolder(asked) ? asked : "invoice";
  const [raw, setRaw] = useState(params.get("q") ?? "");
  const q = useDebounced(raw.trim(), 250);
  const searching = q.length >= 2 && features.includes("index");
  useEffect(() => { if ((params.get("q") ?? "") !== q) setParams((p) => { const n = new URLSearchParams(p); if (q) n.set("q", q); else n.delete("q"); return n; }, { replace: true }); }, [q, params, setParams]);

  // On phones the folders are one scrolling row: keep the open one in view.
  const navRef = useRef<HTMLElement>(null);
  const counts = useQuery({ queryKey: ["files", "folders"], enabled: features.includes("folders"), queryFn: () => api.get<FileFolders>("/attachment-files/folders"), refetchInterval: 120_000 });
  useEffect(() => { navRef.current?.querySelector<HTMLElement>("[aria-current=page]")?.scrollIntoView?.({ block: "nearest", inline: "nearest" }); }, [folder, searching, counts.data]);
  const list = useInfiniteQuery({
    queryKey: ["files", "list", searching ? `q:${q}` : folder],
    enabled: features.includes("folders"),
    initialPageParam: "",
    placeholderData: keepPreviousData,
    queryFn: ({ pageParam }) => api.get<{ items: FileItem[]; next: string | null }>(`/attachment-files?${searching ? `q=${encodeURIComponent(q)}` : `folder=${folder}`}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam: (last) => last.next ?? undefined,
  });

  if (tools.isPending) return <div className="mx-auto max-w-6xl p-6"><Skeleton className="h-8 w-48" /></div>;
  if (!features.includes("folders")) return <div className="mx-auto max-w-6xl p-6"><EmptyState icon={<IconFile />} title="Files is not on here yet" body="Your workspace will see Files once it is switched on." /></div>;
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const indexing = counts.data?.indexing;
  const pick = (f: AttachmentFolder) => { setRaw(""); setParams({ folder: f }); };

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6" data-testid="files-page">
      <PageHeader eyebrow="Tools" title="Files" description="Attachments from your mail, sorted into folders. Search finds words inside them, scans included." />
      <div className="relative mb-4">
        <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
        <Input value={raw} onChange={(e) => setRaw(e.target.value)} placeholder={features.includes("index") ? "Search inside attachments" : "Search is not on here yet"} disabled={!features.includes("index")}
          aria-label="Search inside attachments" className="pl-9" data-testid="files-search" />
      </div>
      <div className="grid gap-4 md:grid-cols-[220px_1fr]">
        <nav ref={navRef} aria-label="Folders" className="flex gap-1.5 overflow-x-auto pb-1 md:flex-col md:overflow-visible md:pb-0">
          {ATTACHMENT_FOLDERS.map((f) => {
            const n = counts.data?.folders.find((x) => x.id === f)?.count;
            const active = !searching && f === folder;
            return (
              <button key={f} type="button" onClick={() => pick(f)} aria-current={active ? "page" : undefined} data-testid={`files-folder-${f}`}
                className={cn("flex shrink-0 items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-[13.5px] transition-colors duration-150 max-sm:min-h-11",
                  active ? "bg-brand/10 font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg")}>
                <span>{ATTACHMENT_FOLDER_LABELS[f]}</span>
                <span className="text-xs tabular-nums text-subtle">{n === undefined ? "" : n.toLocaleString()}</span>
              </button>
            );
          })}
          {indexing && (
            <p className="hidden px-3 pt-3 text-xs text-subtle md:block">
              {!indexing.on ? "Reading attachments is off for this workspace." : indexing.waiting > 0 ? `${indexing.waiting.toLocaleString()} ${indexing.waiting === 1 ? "attachment" : "attachments"} waiting to be read. Older mail is read a little at a time.` : `${indexing.indexed.toLocaleString()} ${indexing.indexed === 1 ? "attachment" : "attachments"} read.`}
            </p>
          )}
        </nav>
        <Card className="min-w-0 overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="text-[15px] font-semibold">{searching ? `Attachments with "${q}"` : ATTACHMENT_FOLDER_LABELS[folder]}</h2>
            {list.isFetching && <span className="text-xs text-subtle">Loading</span>}
          </div>
          {list.isPending ? (
            <div className="space-y-3 p-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
          ) : items.length === 0 ? (
            <EmptyState icon={<IconAttachment />} title={searching ? "Nothing found inside attachments" : "No files here yet"}
              body={searching ? "Try another word. Only attachments that have been read show up here." : indexing?.on === false ? "Reading attachments is off. An admin can turn it on in Settings, General." : "Attachments land here as your mail is read."} />
          ) : (
            <ul className="divide-y divide-line" data-testid="files-list">
              {items.map((it) => <FileRow key={it.attachmentId} it={it} />)}
            </ul>
          )}
          {list.hasNextPage && (
            <div className="border-t border-line p-3 text-center">
              <button type="button" className="text-sm text-brand-hover hover:underline max-sm:min-h-11" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>Show more</button>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function FileRow({ it }: { it: FileItem }) {
  const qc = useQueryClient();
  const move = useMutation({
    mutationFn: (folder: AttachmentFolder) => api.put<{ folder: AttachmentFolder }>(`/attachment-files/${encodeURIComponent(it.attachmentId)}/folder`, { folder }),
    onSuccess: (r) => { toast.success(`Moved to ${ATTACHMENT_FOLDER_LABELS[r.folder]}`); void qc.invalidateQueries({ queryKey: ["files"] }); },
    onError: (e) => showError(e),
  });
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4" data-testid="files-row">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-fill text-muted"><IconFile className="h-4 w-4" /></span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13.5px] font-medium text-fg">{it.filename}</span>
            {it.manual && <Badge>Moved</Badge>}
          </div>
          <div className="truncate text-xs text-subtle">{it.from} · {dateOf(it.date)} · {sizeOf(it.sizeBytes)}</div>
          {it.snippet && <div className="mt-0.5 line-clamp-2 text-xs text-muted">{it.snippet}</div>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 pl-11 sm:pl-0">
        <Link to={it.url} className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-hover hover:text-fg max-sm:min-h-11" title={it.subject}>
          <span className="max-w-40 truncate">{it.subject}</span><IconChevronRight className="h-3.5 w-3.5" />
        </Link>
        <AttachmentTools id={it.attachmentId} filename={it.filename} compact />
        <Menu label={`Move ${it.filename}`} trigger={<button type="button" className="rounded border border-line px-1.5 py-0.5 text-xs text-muted hover:text-fg max-sm:min-h-11">Move to</button>}>
          <MenuLabel>Move to folder</MenuLabel>
          {ATTACHMENT_FOLDERS.filter((f) => f !== it.folder).map((f) => <MenuItem key={f} onSelect={() => move.mutate(f)}>{ATTACHMENT_FOLDER_LABELS[f]}</MenuItem>)}
        </Menu>
      </div>
    </li>
  );
}
