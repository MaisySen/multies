/** R87: the New link and Edit link dialog: destination, back half, title, tags; More options for UTM, end date, click limit, password. */
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { Dialog } from "@/web/components/ui/dialog";
import { Button } from "@/web/components/ui/button";
import { Field, Input } from "@/web/components/ui/input";
import { IconChevronDown, IconChevronRight } from "@/web/components/ui/icon";
import { readUtm, withUtm, type ShortLinkInfo } from "@/shared/links";
import { linksKey, plainUrl } from "./data";

const UTM_FIELDS = [["source", "Source", "newsletter"], ["medium", "Medium", "email"], ["campaign", "Campaign", "spring_sale"], ["term", "Term", ""], ["content", "Content", ""]] as const;
type Utm = Record<(typeof UTM_FIELDS)[number][0], string>;

function localInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function LinkDialog({ open, onClose, base, link, onSaved }: { open: boolean; onClose: () => void; base: string; link?: ShortLinkInfo | null; onSaved?: (l: ShortLinkInfo) => void }) {
  const qc = useQueryClient();
  const editing = !!link;
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [more, setMore] = useState(false);
  const [utm, setUtm] = useState<Utm>({ source: "", medium: "", campaign: "", term: "", content: "" });
  const [ends, setEnds] = useState("");
  const [max, setMax] = useState("");
  const [password, setPassword] = useState("");
  const [clearPw, setClearPw] = useState(false);
  const [codeState, setCodeState] = useState<{ free: boolean; message?: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    const u = link?.url ?? "";
    setUrl(u); setCode(link?.code ?? ""); setTitle(link?.title ?? ""); setTags((link?.tags ?? []).join(", "));
    setUtm(readUtm(u)); setEnds(localInput(link?.expiresAt ?? null)); setMax(link?.maxClicks ? String(link.maxClicks) : "");
    setPassword(""); setClearPw(false); setCodeState(null);
    setMore(!!link && (!!link.expiresAt || !!link.maxClicks || link.hasPassword || Object.values(readUtm(u)).some(Boolean)));
  }, [open, link]);

  // Back half availability, checked as you type (only when it changed).
  useEffect(() => {
    const c = code.trim().toLowerCase();
    if (!open || !c || c === link?.code) { setCodeState(null); return; }
    const t = setTimeout(() => { api.get<{ free: boolean; message?: string }>(`/links/check?code=${encodeURIComponent(c)}`).then(setCodeState).catch(() => setCodeState(null)); }, 300);
    return () => clearTimeout(t);
  }, [code, open, link?.code]);

  const destination = (() => { const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(url.trim()) || !url.trim() ? url.trim() : `https://${url.trim()}`; return more ? withUtm(withScheme, utm) : withScheme; })();
  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        url: destination, code: code.trim() || null, title: title.trim() || null, tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        expiresAt: ends ? new Date(ends).toISOString() : null, maxClicks: max ? Number(max) : null,
      };
      if (password) body.password = password;
      if (editing) { if (clearPw) body.clearPassword = true; return (await api.patch<{ link: ShortLinkInfo }>(`/links/${link!.id}`, body)).link; }
      return (await api.post<{ link: ShortLinkInfo }>("/links", body)).link;
    },
    onSuccess: (l) => {
      void qc.invalidateQueries({ queryKey: linksKey });
      if (!editing) { void navigator.clipboard?.writeText(l.shortUrl).catch(() => undefined); toast.success("Link made and copied", { description: plainUrl(l.shortUrl) }); }
      else toast.success("Link saved");
      onSaved?.(l);
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e), { id: "links-link-dialog-error" }),
  });

  const baseLabel = plainUrl(base);
  return (
    <Dialog open={open} onClose={onClose} title={editing ? "Edit link" : "New short link"} description={editing ? "Change where it goes at any time. The short link stays the same." : "Paste a long address. You get a short link and a QR code."}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!url.trim() || codeState?.free === false} data-testid="link-save">{editing ? "Save" : "Make link"}</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (url.trim()) save.mutate(); }} data-testid="link-dialog">
        <Field label="Destination">{(fp) => (<>
          <Input {...fp} autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/a/very/long/page" inputMode="url" autoComplete="off" data-testid="link-url" />
        </>)}</Field>
        <Field label="Short link" hint={codeState?.free === false ? undefined : codeState?.free ? "Free to use" : "Leave empty for a short random one"} error={codeState && !codeState.free ? codeState.message ?? "This back half is taken. Try another." : undefined}>{(fp) => (<>
          <div className="flex min-w-0 items-stretch overflow-hidden rounded-lg border border-line-strong bg-surface focus-within:ring-2 focus-within:ring-brand">
            <span className="flex shrink-0 items-center bg-fill px-3 text-[13px] text-muted max-sm:max-w-[45%] max-sm:truncate" title={baseLabel}>{baseLabel}/</span>
            <input {...fp} value={code} onChange={(e) => setCode(e.target.value.replace(/\s+/g, "-"))} placeholder="spring-sale" aria-label="Back half" maxLength={48} autoComplete="off" spellCheck={false}
              className="h-9 min-w-0 flex-1 bg-transparent px-2.5 text-sm outline-none max-sm:h-11" data-testid="link-code" />
          </div>
        </>)}</Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title" hint="Only you and your team see it">{(fp) => (<><Input {...fp} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Spring sale email" maxLength={200} /></>)}</Field>
          <Field label="Tags" hint="Separate with commas">{(fp) => (<><Input {...fp} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="email, spring" /></>)}</Field>
        </div>
        <button type="button" onClick={() => setMore((v) => !v)} aria-expanded={more} className="flex min-h-9 items-center gap-1.5 rounded-lg text-[13px] font-medium text-brand-hover hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:min-h-11" data-testid="link-more">
          {more ? <IconChevronDown className="h-4 w-4" aria-hidden /> : <IconChevronRight className="h-4 w-4" aria-hidden />}More options
        </button>
        {more && (
          <div className="space-y-4 rounded-xl border border-line bg-fill/40 p-4">
            <fieldset className="min-w-0">
              <legend className="mb-2 text-[13px] font-medium">Campaign tracking</legend>
              <div className="grid gap-3 sm:grid-cols-3">
                {UTM_FIELDS.map(([k, label, ph]) => (
                  <label key={k} className="block text-[12.5px] text-muted">{label}
                    <Input value={utm[k]} onChange={(e) => setUtm({ ...utm, [k]: e.target.value })} placeholder={ph} className="mt-1" data-testid={`utm-${k}`} />
                  </label>
                ))}
              </div>
              {Object.values(utm).some(Boolean) && <p className="mt-2 break-all text-[12px] text-subtle" data-testid="utm-preview">Opens {destination}</p>}
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Stops working on" hint="Optional">{(fp) => (<><Input {...fp} type="datetime-local" value={ends} onChange={(e) => setEnds(e.target.value)} data-testid="link-ends" /></>)}</Field>
              <Field label="Click limit" hint="Optional. Bots don't count">{(fp) => (<><Input {...fp} type="number" min={1} inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)} placeholder="100" data-testid="link-max" /></>)}</Field>
            </div>
            <Field label={link?.hasPassword ? "New password" : "Password"} hint={link?.hasPassword ? "This link has a password. Type a new one to change it." : "Optional. Visitors type it before the link opens"}>{(fp) => (<>
              <Input {...fp} type="password" value={password} onChange={(e) => { setPassword(e.target.value); setClearPw(false); }} autoComplete="new-password" maxLength={128} data-testid="link-password" />
            </>)}</Field>
            {link?.hasPassword && (
              <label className="flex min-h-9 items-center gap-2 text-[13px]"><input type="checkbox" checked={clearPw} onChange={(e) => setClearPw(e.target.checked)} className="h-4 w-4 accent-[var(--color-brand)]" />Remove the password</label>
            )}
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
