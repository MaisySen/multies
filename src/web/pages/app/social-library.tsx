/**
 * R117: Social, Library. Images, saved captions and hashtag sets the team reuses, tagged by campaign, with the free
 * plan limits shown (200 items, 25 MB of images, 1 MB per image). Use in a post opens New post with it picked.
 */
import { shrinkPhoto } from "@/web/lib/shrink-image"; // SOCFIX
import { SOCIAL_PHOTO_ACCEPT } from "@/shared/social-image"; // SOCFIX
import { useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { Badge, Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Input, Select, Textarea } from "@/web/components/ui/input";
import { Dialog } from "@/web/components/ui/dialog";
import { ConfirmDialog } from "@/web/components/ui/confirm";
import { IconBookmark, IconCopy, IconHash, IconImage, IconPlus, IconText, IconTrash } from "@/web/components/ui/icon";
import { LIBRARY_LIMITS, type LibraryItemView, type LibraryKind } from "@/shared/social-p2";
import { libraryKey, useLibrary } from "./social-composer";
import { LoadFailure } from "@/web/components/load-error-t1g";

const KIND_LABEL: Record<LibraryKind, string> = { image: "Image", caption: "Caption", hashtags: "Hashtag set" };
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;

function AddDialog({ kind, open, onClose, campaigns, item }: { kind: LibraryKind; open: boolean; onClose: () => void; campaigns: string[]; item?: LibraryItemView | null }) {
  const qc = useQueryClient();
  const [name, setName] = useState(item?.name ?? "");
  const [body, setBody] = useState(item?.body ?? "");
  const [campaign, setCampaign] = useState(item?.campaign ?? "");
  const [image, setImage] = useState<{ contentType: string; dataB64: string; src: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const reset = () => { setName(""); setBody(""); setCampaign(""); setImage(null); setErr(null); };
  const save = useMutation({
    mutationFn: () => (item
      ? api.patch<{ item: LibraryItemView }>(`/social/library/${item.id}`, { name, body: item.kind === "image" ? undefined : body, campaign: campaign || null })
      : api.create<{ item: LibraryItemView }>("/social/library", { kind, name, body: kind === "image" ? null : body, campaign: campaign || null, image: image ? { contentType: image.contentType, dataB64: image.dataB64 } : null })),
    onSuccess: () => { toast.success(item ? "Saved" : `${KIND_LABEL[kind]} added to the library`); void qc.invalidateQueries({ queryKey: libraryKey }); reset(); onClose(); },
    onError: (e) => setErr(errorMessage(e, "Couldn't save it. Try again.")),
  });
  const pick = (f: File | undefined) => {
    setErr(null);
    if (!f) return;
    // SOCFIX: any normal photo; shrunk in the browser to fit every network.
    void shrinkPhoto(f).then((p) => { setImage({ contentType: p.contentType, dataB64: p.dataB64, src: p.src }); if (!name) setName(f.name.replace(/\.[a-z0-9]+$/i, "")); }, (e: unknown) => setErr(e instanceof Error ? e.message : "That photo could not be read."));
  };
  const k = item?.kind ?? kind;
  const title = item ? `Edit ${KIND_LABEL[k].toLowerCase()}` : k === "image" ? "Add an image" : k === "caption" ? "Save a caption" : "Save a hashtag set";
  return (
    <Dialog open={open} onClose={() => { reset(); onClose(); }} title={title}
      footer={<><Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button><Button loading={save.isPending} disabled={!name.trim() || (k === "image" ? !item && !image : !body.trim())} onClick={() => save.mutate()} data-testid="library-save">Save</Button></>}>
      <div className="space-y-4" data-testid="library-dialog">
        {k === "image" && !item && (
          <div>
            {image ? <img src={image.src} alt="" className="max-h-48 rounded-lg border border-line" /> : (
              <button type="button" onClick={() => file.current?.click()} className="grid h-32 w-full place-items-center rounded-lg border border-dashed border-line text-[13px] text-muted hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50">
                <span className="flex flex-col items-center gap-1"><IconImage className="h-5 w-5" aria-hidden />Choose a photo. Large ones are resized to fit</span>
              </button>
            )}
            <input ref={file} type="file" accept={SOCIAL_PHOTO_ACCEPT} className="sr-only" tabIndex={-1} aria-hidden data-testid="library-file" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
          </div>
        )}
        <div><label htmlFor="lib-name" className="mb-1.5 block text-[13px] font-medium">Name</label><Input id="lib-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className="h-9 text-sm" data-testid="library-name" /></div>
        {k !== "image" && (
          <div><label htmlFor="lib-body" className="mb-1.5 block text-[13px] font-medium">{k === "caption" ? "Caption" : "Hashtags"}</label>
            <Textarea id="lib-body" rows={k === "caption" ? 5 : 3} value={body} maxLength={LIBRARY_LIMITS.textMax} onChange={(e) => setBody(e.target.value)} placeholder={k === "hashtags" ? "#launch #smallbusiness" : undefined} data-testid="library-body" /></div>
        )}
        <div><label htmlFor="lib-campaign" className="mb-1.5 block text-[13px] font-medium">Campaign <span className="font-normal text-muted">(optional)</span></label>
          <Input id="lib-campaign" list="lib-campaigns" value={campaign} maxLength={40} onChange={(e) => setCampaign(e.target.value)} className="h-9 text-sm" />
          <datalist id="lib-campaigns">{campaigns.map((c) => <option key={c} value={c} />)}</datalist></div>
        {err && <p className="text-[13px] text-bad" role="alert">{err}</p>}
      </div>
    </Dialog>
  );
}

export function SocialLibrary() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const lib = useLibrary();
  const [kind, setKind] = useState<"all" | LibraryKind>("all");
  const [campaign, setCampaign] = useState("");
  const [adding, setAdding] = useState<LibraryKind | null>(null);
  const [editing, setEditing] = useState<LibraryItemView | null>(null);
  const [removing, setRemoving] = useState<LibraryItemView | null>(null);
  const items = useMemo(() => lib.data?.items ?? [], [lib.data]);
  const campaigns = useMemo(() => [...new Set(items.map((i) => i.campaign).filter((c): c is string => !!c))].sort(), [items]);
  const shown = items.filter((i) => (kind === "all" || i.kind === kind) && (!campaign || i.campaign === campaign));
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/social/library/${id}`),
    onSuccess: () => { toast.success("Removed from the library"); setRemoving(null); void qc.invalidateQueries({ queryKey: libraryKey }); },
    onError: (e) => toast.error(errorMessage(e, "Couldn't remove it.")),
  });
  const used = lib.data?.usedBytes ?? 0;
  const full = items.length >= LIBRARY_LIMITS.items;
  const imagesFull = used >= LIBRARY_LIMITS.imageBytes;
  const tab = "inline-flex min-h-9 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 max-sm:min-h-11";

  return (
    <div data-testid="social-library">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="inline-flex flex-wrap gap-1 rounded-lg bg-fill p-1" role="group" aria-label="Show">
          {(["all", "image", "caption", "hashtags"] as const).map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} className={cn(tab, kind === k ? "bg-surface text-fg shadow-card" : "text-muted hover:text-fg")}>
              {k === "all" ? "All" : k === "image" ? "Images" : k === "caption" ? "Captions" : "Hashtags"}
            </button>
          ))}
        </div>
        {campaigns.length > 0 && (
          <Select aria-label="Campaign" value={campaign} onChange={(e) => setCampaign(e.target.value)} className="h-9 w-auto text-sm"><option value="">All campaigns</option>{campaigns.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={full || imagesFull} onClick={() => setAdding("image")} data-testid="library-add-image"><IconImage className="h-4 w-4" aria-hidden />Image</Button>
          <Button variant="outline" size="sm" disabled={full} onClick={() => setAdding("caption")} data-testid="library-add-caption"><IconText className="h-4 w-4" aria-hidden />Caption</Button>
          <Button variant="outline" size="sm" disabled={full} onClick={() => setAdding("hashtags")} data-testid="library-add-hashtags"><IconHash className="h-4 w-4" aria-hidden />Hashtags</Button>
        </div>
      </div>
      {lib.data && (
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-muted" data-testid="library-usage">
          <span className="tabular-nums">{items.length} of {LIBRARY_LIMITS.items} items</span>
          <span className="flex items-center gap-2 tabular-nums">
            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-fill" aria-hidden><span className={cn("block h-full rounded-full", imagesFull ? "bg-bad" : "bg-brand")} style={{ width: `${Math.min(100, (used / LIBRARY_LIMITS.imageBytes) * 100)}%` }} /></span>
            {mb(used)} of {mb(LIBRARY_LIMITS.imageBytes)} of images
          </span>
          {(full || imagesFull) && <span className="text-warn">The free plan's library is full. Remove something to add more.</span>}
        </div>
      )}
      {lib.isPending ? <div className="grid grid-cols-2 gap-3 md:grid-cols-4"><Skeleton className="h-40 rounded-xl" /><Skeleton className="h-40 rounded-xl" /></div>
        : lib.error ? <Card className="p-5"><LoadFailure error={lib.error} onRetry={() => lib.refetch()} /></Card>
        : !shown.length ? (
          <Card><EmptyState icon={<IconBookmark />} title={items.length ? "Nothing matches" : "Your library is empty"} body={items.length ? "Try another filter." : "Keep images, captions and hashtag sets here, then pick them in New post."}
            action={items.length ? undefined : <Button onClick={() => setAdding("image")}><IconPlus className="h-4 w-4" aria-hidden />Add an image</Button>} /></Card>
        ) : (
          <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4" data-testid="library-items">
            {shown.map((i) => (
              <li key={i.id}>
                <Card className="flex h-full flex-col overflow-hidden" data-testid="library-item" data-kind={i.kind}>
                  {i.kind === "image" ? <img src={i.imageUrl ?? ""} alt={i.name} className="aspect-[4/3] w-full bg-fill object-cover" loading="lazy" />
                    : <p className="line-clamp-5 min-h-[6rem] whitespace-pre-line break-words bg-fill px-3 py-2.5 text-[13px] leading-relaxed">{i.body}</p>}
                  <div className="flex flex-1 flex-col gap-1.5 p-3">
                    <p className="truncate text-[13.5px] font-medium">{i.name}</p>
                    <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted">{KIND_LABEL[i.kind]}{i.kind === "image" && ` · ${Math.round(i.sizeBytes / 1024)} KB`}{i.campaign && <Badge tone="neutral">{i.campaign}</Badge>}</p>
                    <div className="mt-auto flex flex-wrap gap-1 pt-1">
                      <Button variant="outline" size="sm" onClick={() => navigate(`/app/social/new?lib=${encodeURIComponent(i.id)}`)}>Use in a post</Button>
                      {i.kind !== "image" && <Button variant="ghost" size="sm" aria-label={`Copy ${i.name}`} onClick={() => void navigator.clipboard?.writeText(i.body ?? "").then(() => toast.success("Copied"))}><IconCopy className="h-4 w-4" aria-hidden /></Button>}
                      <Button variant="ghost" size="sm" onClick={() => setEditing(i)} aria-label={`Edit ${i.name}`}>Edit</Button>
                      <Button variant="ghost" size="sm" className="text-bad hover:text-bad" aria-label={`Remove ${i.name}`} onClick={() => setRemoving(i)}><IconTrash className="h-4 w-4" aria-hidden /></Button>
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      {adding && <AddDialog key={adding} kind={adding} open onClose={() => setAdding(null)} campaigns={campaigns} />}
      {editing && <AddDialog key={editing.id} kind={editing.kind} item={editing} open onClose={() => setEditing(null)} campaigns={campaigns} />}
      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => removing && remove.mutate(removing.id)} busy={remove.isPending}
        title="Remove from the library?" description="Posts that already used it keep it." confirmLabel="Remove" />
    </div>
  );
}
