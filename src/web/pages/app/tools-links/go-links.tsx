/** R87: team go links. go/name opens a doc, a task, a project or any web address. Members only. */
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { useContentSearch } from "@/web/lib/search";
import { useProjects } from "@/web/pages/app/work/data";
import { Dialog } from "@/web/components/ui/dialog";
import { ConfirmDialog } from "@/web/components/ui/confirm";
import { Button } from "@/web/components/ui/button";
import { Field, Input, Select } from "@/web/components/ui/input";
import { Card, CopyButton, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { IconDocs, IconEdit, IconGlobe, IconHash, IconPlus, IconProject, IconSearch, IconTasks, IconTrash } from "@/web/components/ui/icon";
import { GO_NAME_RE, type GoLinkInfo, type GoTargetKind } from "@/shared/links";
import { cn } from "@/web/lib/cn";
import { useGoLinks } from "./data";

const KINDS: { k: GoTargetKind; label: string; icon: typeof IconDocs }[] = [
  { k: "doc", label: "Doc", icon: IconDocs }, { k: "task", label: "Task", icon: IconTasks }, { k: "project", label: "Project", icon: IconProject }, { k: "url", label: "Web address", icon: IconGlobe },
];
const iconOf = (k: GoTargetKind) => KINDS.find((x) => x.k === k)?.icon ?? IconGlobe;
const ring = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand";

export function GoLinksTab() {
  const [params, setParams] = useSearchParams();
  const list = useGoLinks();
  const [q, setQ] = useState("");
  const preset = params.get("new");
  const [editing, setEditing] = useState<GoLinkInfo | "new" | null>(preset ? "new" : null);
  const [deleting, setDeleting] = useState<GoLinkInfo | null>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const del = useMutation({
    mutationFn: (g: GoLinkInfo) => api.del(`/links/go/${g.id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["links-go"] }); toast.success("Go link deleted"); setDeleting(null); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const links = useMemo(() => list.data?.links ?? [], [list.data]);
  const shown = useMemo(() => { const s = q.trim().toLowerCase().replace(/^go\//, ""); return links.filter((l) => !s || `${l.name} ${l.label ?? ""} ${l.description ?? ""}`.toLowerCase().includes(s)); }, [links, q]);
  const open = (g: GoLinkInfo) => { if (g.targetKind === "url") window.open(g.href, "_blank", "noopener"); else navigate(`/app/go/${g.name}`); };

  return (
    <div className="space-y-3 pt-4" data-testid="go-links">
      <p className="text-[13px] text-muted">Type <span className="rounded bg-fill px-1.5 py-0.5 font-medium text-fg">go/name</span> in the command menu, or open <span className="font-medium text-fg">{location.host}/go/name</span>, to jump straight to a doc, task, project or page. Only people in this workspace can use them.</p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1 basis-56">
          <span className="sr-only">Search go links</span>
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search go links" className={cn("h-9 w-full rounded-lg border border-line-strong bg-surface pl-9 pr-3 text-sm placeholder:text-subtle max-sm:h-11", ring)} />
        </label>
        <Button onClick={() => setEditing("new")} data-testid="go-new"><IconPlus className="h-4 w-4" />New go link</Button>
      </div>
      {list.isError ? (
        <Card className="p-6 text-center"><p className="font-medium">Couldn't load go links</p><Button variant="outline" className="mt-3" onClick={() => void list.refetch()}>Try again</Button></Card>
      ) : list.isLoading ? (
        <Card className="divide-y divide-line" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="flex gap-3 p-4"><Skeleton className="h-8 w-8 rounded-lg" /><div className="flex-1 space-y-2"><Skeleton className="w-1/4" /><Skeleton className="h-3 w-1/2" /></div></div>)}</Card>
      ) : !links.length ? (
        <Card><EmptyState icon={<IconHash />} title="Make the first go link" body="Give the docs and pages your team opens every day a short name, like go/onboarding or go/roadmap." action={<Button onClick={() => setEditing("new")}><IconPlus className="h-4 w-4" />New go link</Button>} /></Card>
      ) : !shown.length ? (
        <Card><EmptyState icon={<IconSearch />} title="No go links match" body={<>Nothing is called go/{q.replace(/^go\//, "")} yet.</>} action={<Button variant="outline" onClick={() => setEditing("new")}>Make it</Button>} /></Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {shown.map((g) => { const I = iconOf(g.targetKind); return (
              <li key={g.id} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-hover/50" data-testid="go-row">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-fill text-muted" aria-hidden><I className="h-4 w-4" /></span>
                <button type="button" onClick={() => open(g)} className={cn("min-w-0 flex-1 rounded-md text-left", ring)}>
                  <span className="block font-medium">go/{g.name}</span>
                  <span className="block truncate text-[12.5px] text-muted">{g.description || g.label || g.href}</span>
                </button>
                <span className="text-[12.5px] tabular-nums text-muted">{g.clicks} {g.clicks === 1 ? "open" : "opens"}</span>
                <div className="flex items-center gap-1">
                  <CopyButton value={`${location.origin}/go/${g.name}`} label="Copy" toastText={`go/${g.name} copied`} />
                  {g.canEdit && <><Button size="icon" variant="ghost" onClick={() => setEditing(g)} aria-label={`Edit go/${g.name}`}><IconEdit className="h-4 w-4" /></Button>
                    <Button size="icon" variant="ghost" onClick={() => setDeleting(g)} aria-label={`Delete go/${g.name}`}><IconTrash className="h-4 w-4" /></Button></>}
                </div>
              </li>
            ); })}
          </ul>
        </Card>
      )}
      <GoDialog open={!!editing} link={editing === "new" ? null : editing} preset={preset ?? (editing === "new" ? q.replace(/^go\//, "") : "")} onClose={() => { setEditing(null); if (preset) { const p = new URLSearchParams(params); p.delete("new"); setParams(p, { replace: true }); } }} />
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={() => deleting && del.mutate(deleting)} busy={del.isPending} title={`Delete go/${deleting?.name ?? ""}?`} description="People who use this name will see a not found page. What it opened is not touched." confirmLabel="Delete" />
    </div>
  );
}

function GoDialog({ open, link, preset, onClose }: { open: boolean; link: GoLinkInfo | null; preset: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<GoTargetKind>("doc");
  const [target, setTarget] = useState<{ id: string; title: string } | null>(null);
  const [url, setUrl] = useState("");
  const [desc, setDesc] = useState("");
  const [find, setFind] = useState("");
  useEffect(() => {
    if (!open) return;
    setName(link?.name ?? preset.toLowerCase()); setKind(link?.targetKind ?? "doc"); setUrl(link?.url && link.targetKind === "url" ? link.url : "");
    setTarget(link?.targetId ? { id: link.targetId, title: link.label ?? link.targetId } : null); setDesc(link?.description ?? ""); setFind("");
  }, [open, link, preset]);
  const search = useContentSearch(find, open && (kind === "doc" || kind === "task"));
  const hits = (search.data?.groups ?? []).filter((g) => g.type === (kind === "doc" ? "docs" : "tasks")).flatMap((g) => g.items).slice(0, 6);
  const projects = useProjects();
  const okName = GO_NAME_RE.test(name);
  const save = useMutation({
    mutationFn: () => {
      const body = { name, targetKind: kind, targetId: kind === "url" ? null : target?.id ?? null, url: kind === "url" ? url : null, description: desc || null };
      return link ? api.patch(`/links/go/${link.id}`, body) : api.post("/links/go", body);
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["links-go"] }); toast.success(link ? "Go link saved" : `go/${name} is ready`); onClose(); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const ready = okName && (kind === "url" ? !!url.trim() : !!target);
  return (
    <Dialog open={open} onClose={onClose} title={link ? `Edit go/${link.name}` : "New go link"} description="A short name your whole workspace can type to open something."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} disabled={!ready} loading={save.isPending} data-testid="go-save">{link ? "Save" : "Make go link"}</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (ready) save.mutate(); }} data-testid="go-dialog">
        <Field label="Name" error={name && !okName ? "Use lowercase letters and numbers, up to 48 characters." : undefined}>{(fp) => (<>
          <div className="flex min-w-0 items-stretch overflow-hidden rounded-lg border border-line-strong bg-surface focus-within:ring-2 focus-within:ring-brand">
            <span className="flex items-center bg-fill px-3 text-[13px] text-muted">go/</span>
            <input {...fp} autoFocus value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/^go\//, "").replace(/\s+/g, "-"))} placeholder="onboarding" aria-label="Go link name" maxLength={48} className="h-9 min-w-0 flex-1 bg-transparent px-2.5 text-sm outline-none max-sm:h-11" data-testid="go-name" />
          </div>
        </>)}</Field>
        <fieldset className="min-w-0">
          <legend className="mb-1.5 text-[13px] font-medium">Opens</legend>
          <div role="radiogroup" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {KINDS.map(({ k, label, icon: I }) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => { setKind(k); setTarget(null); setFind(""); }} data-testid={`go-kind-${k}`}
                className={cn("flex h-10 items-center justify-center gap-1.5 rounded-lg border text-[13px] font-medium transition-colors max-sm:h-11", ring, kind === k ? "border-brand bg-brand-soft text-brand-hover" : "border-line-strong text-muted hover:text-fg")}><I className="h-4 w-4" aria-hidden />{label}</button>
            ))}
          </div>
        </fieldset>
        {kind === "url" && <Field label="Web address">{(fp) => (<><Input {...fp} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/handbook" inputMode="url" data-testid="go-url" /></>)}</Field>}
        {kind === "project" && (
          <Field label="Project">{(fp) => (<>
            <Select {...fp} value={target?.id ?? ""} onChange={(e) => { const p = projects.data?.find((x) => x.id === e.target.value); setTarget(p ? { id: p.id, title: p.name } : null); }} data-testid="go-project">
              <option value="">Pick a project</option>
              {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </>)}</Field>
        )}
        {(kind === "doc" || kind === "task") && (
          <Field label={kind === "doc" ? "Doc" : "Task"}>{(fp) => (<>
            {target ? (
              <div className="flex items-center gap-2 rounded-lg border border-line-strong px-3 py-2 text-sm"><span className="min-w-0 flex-1 truncate font-medium">{target.title}</span><Button size="sm" variant="ghost" onClick={() => setTarget(null)}>Change</Button></div>
            ) : (
              <div>
                <Input {...fp} value={find} onChange={(e) => setFind(e.target.value)} placeholder={kind === "doc" ? "Search docs by title" : "Search tasks by title"} aria-label={`Search ${kind}s`} data-testid="go-find" />
                {find.trim().length >= 2 && (
                  <ul className="mt-1.5 max-h-48 overflow-auto rounded-lg border border-line" role="listbox" aria-label="Results">
                    {search.loading && !hits.length ? <li className="px-3 py-2 text-[13px] text-muted">Searching</li> : !hits.length ? <li className="px-3 py-2 text-[13px] text-muted">Nothing matches</li> :
                      hits.map((h) => <li key={h.id}><button type="button" role="option" aria-selected={false} onClick={() => setTarget({ id: h.id, title: h.title })} className={cn("block w-full px-3 py-2 text-left text-sm hover:bg-hover", ring)}><span className="block truncate">{h.title}</span>{h.subtitle && <span className="block truncate text-[12px] text-muted">{h.subtitle}</span>}</button></li>)}
                  </ul>
                )}
              </div>
            )}
          </>)}</Field>
        )}
        <Field label="Note" hint="Optional. Shows in search">{(fp) => (<><Input {...fp} value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={200} placeholder="Start here if you're new" /></>)}</Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
