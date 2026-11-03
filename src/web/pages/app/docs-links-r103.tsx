/**
 * R103: Docs > Link library. The team's saved links with tags, and "Save a page": a public web page saved as a clean
 * doc into a collection (a page of the docs tree, "Web clips" by default), with a PDF snapshot to download.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { Button } from "@/web/components/ui/button";
import { Input, Select, Textarea } from "@/web/components/ui/input";
import { Card, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { Dialog } from "@/web/components/ui/dialog";
import { IconBookmark, IconDocs, IconDownload, IconEdit, IconExternalLink, IconGlobe, IconLink, IconPlus, IconSearch, IconTag, IconTrash } from "@/web/components/ui/icon";
import { normalizeTags, siteOf } from "@/shared/docs-plus";
import { DocTreeSidebar } from "./work/doc-tree";
import { LoadError } from "@/web/components/load-error-t1g";
import { tr } from "@/web/i18n"; // R104B
import "@/web/i18n/w2/en-docs"; // R104B

interface SavedLink { id: string; url: string; title: string; description: string; site: string; tags: string[]; note: string; docId: string | null; createdAt: string; canRemove: boolean }
interface DocSummary { id: string; title: string }

const KEY = ["docs-links-r103"];

function TagChips({ tags, onPick, active }: { tags: string[]; onPick?: (t: string) => void; active?: string }) {
  if (!tags.length) return null;
  return (
    <ul className="flex flex-wrap gap-1" aria-label={tr("tasks.tags")}>
      {tags.map((t) => (
        <li key={t}>{onPick
          ? <button type="button" onClick={() => onPick(t)} aria-pressed={active === t} className={cn("inline-flex min-h-7 items-center gap-1 rounded-full border px-2 text-[12px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:min-h-9", active === t ? "border-brand bg-brand-soft text-brand-hover" : "border-line text-muted hover:bg-hover hover:text-fg")}>#{t}</button>
          : <span className="inline-flex min-h-6 items-center rounded-full border border-line px-2 text-[12px] text-muted">#{t}</span>}
        </li>
      ))}
    </ul>
  );
}

function SaveDialog({ mode, open, onClose, initialUrl }: { mode: "page" | "link"; open: boolean; onClose: () => void; initialUrl?: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [url, setUrl] = useState("");
  const [tags, setTags] = useState("");
  const [note, setNote] = useState("");
  const [parentId, setParentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const docs = useQuery({ queryKey: ["docs", ""], queryFn: async () => (await api.get<{ docs: DocSummary[] }>("/docs")).docs, enabled: open && mode === "page" });
  useEffect(() => { if (open) { setUrl(initialUrl ?? ""); setTags(""); setNote(""); setParentId(""); setError(null); } }, [open, initialUrl]);
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      if (mode === "page") {
        const r = await api.post<{ doc: { id: string; title: string } }>("/docs-plus/clip", { url, tags: normalizeTags(tags), parentId: parentId || null });
        toast.success(tr("docs.saved_title_as_a_doc", { title: r.doc.title }), { action: { label: tr("tours.open"), onClick: () => navigate(`/app/docs/${r.doc.id}`) } });
      } else {
        const r = await api.post<{ existing: boolean }>("/docs-plus/links", { url, tags: normalizeTags(tags), note });
        toast.success(r.existing ? tr("docs.already_in_the_library_tags_added") : tr("docs.link_saved"));
      }
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["docs-links-tags-r103"] });
      onClose();
    } catch (e) { setError((e as Error).message || "That did not work. Try again."); } finally { setBusy(false); }
  };
  const valid = url.trim().length > 3;
  return (
    <Dialog open={open} onClose={onClose} title={mode === "page" ? tr("docs.save_a_page") : tr("docs.add_a_link")}
      description={mode === "page" ? tr("docs.we_save_the_readable_text_of_a_public_page_as_a") : tr("docs.keep_a_link_in_the_team_library_with_tags")}
      footer={<><Button variant="ghost" onClick={onClose}>{tr("common.cancel")}</Button><Button onClick={() => void submit()} disabled={!valid || busy} data-testid="save-link-submit">{busy ? (mode === "page" ? tr("docs.saving_page") : tr("docs.saving")) : mode === "page" ? tr("docs.save_page") : tr("docs.save_link")}</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid && !busy) void submit(); }}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") { e.preventDefault(); if (valid && !busy) void submit(); } }}>
        <label className="block text-[13px] font-medium">{tr("docs.web_address")}
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/article" inputMode="url" autoFocus className="mt-1" data-testid="save-link-url" aria-invalid={!!error} aria-describedby={error ? "save-link-error" : undefined} />
        </label>
        {mode === "page" && (
          <label className="block text-[13px] font-medium">{tr("docs.save_into")}
            <Select value={parentId} onChange={(e) => setParentId(e.target.value)} className="mt-1" aria-label={tr("docs.save_into")}>
              <option value="">{tr("docs.web_clips_made_for_you")}</option>
              {(docs.data ?? []).slice(0, 200).map((d) => <option key={d.id} value={d.id}>{d.title || tr("docs.untitled")}</option>)}
            </Select>
          </label>
        )}
        <label className="block text-[13px] font-medium">{tr("tasks.tags")}
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder={tr("docs.research_design")} className="mt-1" data-testid="save-link-tags" />
          <span className="mt-1 block text-[12px] font-normal text-subtle">{tr("docs.separate_tags_with_commas")}</span>
        </label>
        {mode === "link" && <label className="block text-[13px] font-medium">{tr("docs.note")}<Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} className="mt-1" /></label>}
        {error && <p id="save-link-error" role="alert" className="text-[13px] text-[color:var(--danger,#c0362c)]">{error}</p>}
        {busy && mode === "page" && <p role="status" className="text-[13px] text-muted">{tr("docs.reading_the_page_this_takes_a_few_seconds")}</p>}
      </form>
    </Dialog>
  );
}

function EditDialog({ link, onClose }: { link: SavedLink | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => { if (link) { setTitle(link.title); setTags(link.tags.join(", ")); setNote(link.note); } }, [link]);
  const save = async () => {
    if (!link) return;
    try { await api.patch(`/docs-plus/links/${link.id}`, { title, tags: normalizeTags(tags), note }); void qc.invalidateQueries({ queryKey: KEY }); void qc.invalidateQueries({ queryKey: ["docs-links-tags-r103"] }); toast.success(tr("docs.link_updated")); onClose(); } catch (e) { showError(e as Error); }
  };
  return (
    <Dialog open={!!link} onClose={onClose} title={tr("docs.edit_link")} footer={<><Button variant="ghost" onClick={onClose}>{tr("common.cancel")}</Button><Button onClick={() => void save()}>{tr("common.save")}</Button></>}>
      <div className="space-y-3">
        <label className="block text-[13px] font-medium">{tr("common.title")}<Input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1" maxLength={300} /></label>
        <label className="block text-[13px] font-medium">{tr("tasks.tags")}<Input value={tags} onChange={(e) => setTags(e.target.value)} className="mt-1" /></label>
        <label className="block text-[13px] font-medium">{tr("docs.note")}<Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} className="mt-1" /></label>
      </div>
    </Dialog>
  );
}

export function DocsLinksPage() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState("");
  const [tag, setTag] = useState<string | undefined>(undefined);
  const [only, setOnly] = useState<"all" | "pages">("all");
  const [dialog, setDialog] = useState<"page" | "link" | null>(null);
  const [editing, setEditing] = useState<SavedLink | null>(null);
  const [removing, setRemoving] = useState<SavedLink | null>(null);
  const [pdfBusy, setPdfBusy] = useState<string | null>(null);
  const qs = new URLSearchParams();
  if (q.trim()) qs.set("q", q.trim());
  if (tag) qs.set("tag", tag);
  if (only === "pages") qs.set("clipped", "1");
  const list = useQuery({ queryKey: [...KEY, qs.toString()], queryFn: () => api.get<{ links: SavedLink[]; more: boolean }>(`/docs-plus/links${qs.toString() ? `?${qs}` : ""}`) });
  const tags = useQuery({ queryKey: ["docs-links-tags-r103"], queryFn: () => api.get<{ tags: { tag: string; count: number }[] }>("/docs-plus/links/tags") });
  // Ctrl K "Save a web page" opens the dialog: /app/docs/links?save=page
  useEffect(() => {
    const s = params.get("save");
    if (s === "page" || s === "link") { setDialog(s); const next = new URLSearchParams(params); next.delete("save"); setParams(next, { replace: true }); }
  }, [params, setParams]);
  const filtered = !!(q.trim() || tag || only === "pages");
  const remove = async () => {
    if (!removing) return;
    try { await api.del(`/docs-plus/links/${removing.id}`); toast.success(tr("docs.link_removed")); setRemoving(null); void qc.invalidateQueries({ queryKey: KEY }); void qc.invalidateQueries({ queryKey: ["docs-links-tags-r103"] }); } catch (e) { showError(e as Error); }
  };
  const pdf = async (l: SavedLink) => {
    if (!l.docId) return;
    setPdfBusy(l.id);
    try {
      const d = (await api.get<{ doc: { title: string; content: { type: string } } }>(`/docs/${l.docId}`)).doc;
      const { downloadDocPdf } = await import("@/web/lib/doc-pdf-r103");
      await downloadDocPdf(d.title, d.content, `Saved from ${l.url}`);
    } catch (e) { showError(e as Error); } finally { setPdfBusy(null); }
  };
  const topTags = useMemo(() => (tags.data?.tags ?? []).slice(0, 20).map((t) => t.tag), [tags.data]);
  return (
    <div className="flex gap-6">
      <DocTreeSidebar />
      <div className="min-w-0 flex-1">
        <PageHeader title={tr("nav.link_library")} description={tr("docs.links_the_team_keeps_with_tags_save_a_public_pag")}
          actions={<div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => setDialog("link")} data-testid="add-link"><IconLink className="h-4 w-4" />{tr("docs.add_link")}</Button><Button onClick={() => setDialog("page")} data-testid="save-page"><IconPlus className="h-4 w-4" />{tr("docs.save_a_page")}</Button></div>} />
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-sm">
            <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
            <Input aria-label={tr("docs.search_links")} placeholder={tr("docs.search_links")} value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
          </div>
          <div role="group" aria-label={tr("docs.show")} className="inline-flex rounded-lg border border-line p-0.5">
            {(["all", "pages"] as const).map((k) => (
              <button key={k} type="button" aria-pressed={only === k} onClick={() => setOnly(k)} className={cn("min-h-9 rounded-md px-3 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand", only === k ? "bg-brand-soft font-medium text-brand-hover" : "text-muted hover:text-fg")}>{k === "all" ? tr("docs.all_links") : tr("docs.saved_pages")}</button>
            ))}
          </div>
        </div>
        {topTags.length > 0 && <div className="mb-4 flex items-center gap-2"><IconTag className="h-4 w-4 shrink-0 text-subtle" aria-hidden /><TagChips tags={topTags} active={tag} onPick={(t) => setTag((x) => (x === t ? undefined : t))} /></div>}
        {list.isPending ? <div role="status" className="grid gap-3 sm:grid-cols-2" aria-busy="true" aria-label={tr("docs.loading_links")}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32" />)}</div>
          : list.error ? <Card><LoadError onRetry={() => list.refetch()} /></Card>
            : !list.data?.links.length ? (
              <Card><EmptyState icon={<IconBookmark className="h-5 w-5" />} title={filtered ? tr("docs.no_links_match") : tr("docs.no_links_yet")}
                body={filtered ? "Try another word or tag." : "Keep useful links here with tags, or save a public page as a clean doc your team can read and comment on."}
                action={!filtered && <div className="flex flex-wrap justify-center gap-2"><Button onClick={() => setDialog("page")}>{tr("docs.save_a_page")}</Button><Button variant="secondary" onClick={() => setDialog("link")}>{tr("docs.add_link")}</Button></div>} /></Card>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2" data-testid="link-list">
                {list.data.links.map((l) => (
                  <li key={l.id} className="flex min-w-0 flex-col rounded-xl border border-line bg-surface p-4 transition-colors duration-150 hover:border-line-strong" data-testid="link-card">
                    <p className="flex min-w-0 items-center gap-1.5 text-[12px] text-subtle">{l.docId ? <IconDocs className="h-3.5 w-3.5 shrink-0" aria-label={tr("docs.saved_page")} /> : <IconGlobe className="h-3.5 w-3.5 shrink-0" aria-hidden />}<span className="truncate">{l.site || siteOf(l.url)}</span><span aria-hidden>·</span><span className="shrink-0">{timeAgo(l.createdAt)}</span></p>
                    <a href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="mt-1 line-clamp-2 break-words text-[15px] font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">{l.title}<IconExternalLink className="ml-1 inline h-3.5 w-3.5 text-subtle" aria-label={tr("docs.opens_in_a_new_tab")} /></a>
                    {l.description && <p className="mt-1 line-clamp-2 text-[13px] text-muted">{l.description}</p>}
                    {l.note && <p className="mt-1 line-clamp-2 text-[13px] italic text-muted">{l.note}</p>}
                    <div className="mt-2"><TagChips tags={l.tags} /></div>
                    <div className="mt-auto flex flex-wrap gap-1 pt-3">
                      {l.docId && <Link to={`/app/docs/${l.docId}`} className="inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-[13px] font-medium text-brand-hover hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:min-h-11"><IconDocs className="h-3.5 w-3.5" />{tr("docs.open_doc")}</Link>}
                      {l.docId && <Button size="sm" variant="ghost" onClick={() => void pdf(l)} disabled={pdfBusy === l.id} aria-label={tr("docs.download_title_as_pdf", { title: l.title })}><IconDownload className="h-3.5 w-3.5" />{pdfBusy === l.id ? tr("docs.making_pdf") : "PDF"}</Button>}
                      <Button size="sm" variant="ghost" onClick={() => setEditing(l)} aria-label={tr("docs.edit_title", { title: l.title })}><IconEdit className="h-3.5 w-3.5" />{tr("docs.edit")}</Button>
                      {l.canRemove && <Button size="sm" variant="ghost" onClick={() => setRemoving(l)} aria-label={tr("docs.remove_title", { title: l.title })}><IconTrash className="h-3.5 w-3.5" />{tr("common.remove")}</Button>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
        {list.data?.more && <p className="mt-3 text-[13px] text-muted">{tr("docs.showing_the_newest_200_search_or_pick_a_tag_to_f")}</p>}
      </div>
      <SaveDialog mode={dialog ?? "link"} open={!!dialog} onClose={() => setDialog(null)} />
      <EditDialog link={editing} onClose={() => setEditing(null)} />
      <Dialog open={!!removing} onClose={() => setRemoving(null)} title={tr("docs.remove_this_link")} description={removing?.docId ? tr("docs.the_saved_doc_stays_in_docs") : tr("docs.it_leaves_the_team_library")}
        footer={<><Button variant="ghost" onClick={() => setRemoving(null)}>{tr("common.cancel")}</Button><Button onClick={() => void remove()} data-testid="confirm-remove-link">{tr("common.remove")}</Button></>} />
    </div>
  );
}
