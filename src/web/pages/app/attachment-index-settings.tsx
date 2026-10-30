/**
 * Tools P2 (17): Settings, General, beside the Tools switch. Workspace admins turn "search inside attachments"
 * off (which deletes the stored text and index) or back on, and pick the scan language. Shown only while the
 * deployment has the index feature (GET /api/tools features) and the workspace has Tools on.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { useConfig, useMe } from "@/web/lib/queries";
import { Skeleton, Switch } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Select } from "@/web/components/ui/input";
import type { ToolsInfo } from "@/shared/tools";

type SectionComp = (p: { id?: string; title: string; description: React.ReactNode; children: React.ReactNode }) => React.ReactElement;
interface IndexSettings { on: boolean; lang: string; langs: { id: string; label: string }[] }

export function AttachmentIndexSection({ Section }: { Section: SectionComp }) {
  const config = useConfig();
  const me = useMe();
  const qc = useQueryClient();
  const tools = useQuery({ queryKey: ["tools"], enabled: !!config.data?.tools, queryFn: () => api.get<ToolsInfo>("/tools"), retry: false });
  const on = !!tools.data?.features?.includes("index");
  const q = useQuery({ queryKey: ["files-settings"], enabled: on, retry: false, queryFn: () => api.get<IndexSettings>("/attachment-files/settings") });
  const [confirm, setConfirm] = useState(false);
  const m = useMutation({
    mutationFn: (v: { on?: boolean; lang?: string }) => api.put<{ on: boolean; lang: string }>("/attachment-files/settings", v),
    onSuccess: (r, v) => {
      qc.setQueryData<IndexSettings>(["files-settings"], (old) => (old ? { ...old, ...r } : old));
      qc.invalidateQueries({ queryKey: ["files"] });
      if (v.on !== undefined) toast.success(r.on ? "Search inside attachments turned on" : "Search inside attachments turned off. Its stored text is being deleted.");
      setConfirm(false);
    },
    onError: (e) => showError(e),
  });
  if (!on || q.isError) return null;
  const isAdmin = me.data?.organization?.role !== "member";
  return (
    <Section id="attachment-search" title="Search inside attachments"
      description="Multies reads the text in PDFs, scans, Word and Excel files attached to your mail, so search finds words inside them and files them into folders like Invoices and Receipts. The text is stored in your workspace and deleted with the message, or when you turn this off.">
      {q.isPending ? <Skeleton className="h-6 w-64" /> : (
        <div className="space-y-3 text-sm">
          <Switch checked={!!q.data?.on} disabled={!isAdmin || m.isPending} label="Read the text in mail attachments"
            onChange={(v) => (v ? m.mutate({ on: true }) : setConfirm(true))} />
          {q.data && q.data.langs.length > 1 && (
            <label className="flex flex-wrap items-center gap-2 text-muted">
              <span>Scans are read in</span>
              <Select aria-label="Scan language" value={q.data.lang} disabled={!isAdmin || m.isPending || !q.data.on} onChange={(e) => m.mutate({ lang: e.target.value })} className="w-auto">
                {q.data.langs.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </Select>
            </label>
          )}
          {!isAdmin && <p className="text-muted">Only workspace admins can change this.</p>}
        </div>
      )}
      <Dialog open={confirm} onClose={() => setConfirm(false)} title="Turn off search inside attachments?"
        footer={<><Button variant="secondary" onClick={() => setConfirm(false)}>Keep it on</Button><Button variant="danger" loading={m.isPending} onClick={() => m.mutate({ on: false })}>Turn off and delete</Button></>}>
        <p className="text-sm text-muted">The text read from attachments is deleted and search stops finding words inside them. The attachments themselves stay in your mail. You can turn this back on later; older mail is then read again over a few days.</p>
      </Dialog>
    </Section>
  );
}
