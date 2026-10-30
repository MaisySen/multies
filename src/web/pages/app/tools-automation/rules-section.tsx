/**
 * Tools P2 (flag rules): "Before sending" rules. Admins set the workspace rules; anyone can set their own,
 * which win over the workspace. The composer applies them to attachments (mail/compose-attachments.tsx).
 */
import { useState, useEffect, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Select } from "@/web/components/ui/input";
import { Skeleton } from "@/web/components/ui/misc";
import { RULE_MB_MAX, RULE_MB_MIN, type SendRules, type SendRulesRow } from "@/shared/tools-automation";

interface RulesState { workspace: SendRulesRow | null; mine: SendRulesRow | null; effective: SendRules; canEditWorkspace: boolean }
type SectionCmp = (p: { id?: string; title: string; description: ReactNode; children: ReactNode }) => ReactNode;

const MB_CHOICES = [1, 2, 3, 5, 10, 15, 20, 25].filter((n) => n >= RULE_MB_MIN && n <= RULE_MB_MAX);
const empty: SendRulesRow = { compress: null, compressOverMb: null, wordPdf: null };

function RuleRows({ row, inherit, onSave, disabled, who }: { row: SendRulesRow; inherit: string | null; onSave: (r: SendRulesRow) => void; disabled: boolean; who: "workspace" | "mine" }) {
  const [r, setR] = useState(row);
  useEffect(() => setR(row), [row]);
  const save = (next: SendRulesRow) => { setR(next); onSave(next); };
  const choice = (v: "on" | "off" | null) => (v === null ? "" : v);
  const opts = (
    <>
      {inherit !== null && <option value="">Follow the workspace ({inherit})</option>}
      {inherit === null && <option value="">Off</option>}
      <option value="on">On</option>
      <option value="off">Off for me</option>
    </>
  );
  const wsOpts = (<><option value="off">Off</option><option value="on">On</option></>);
  return (
    <div className="space-y-3 text-sm" data-testid={`rules-${who}`}>
      <label className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1">Compress PDFs over</span>
        <Select value={String(r.compressOverMb ?? 5)} disabled={disabled} onChange={(e) => save({ ...r, compressOverMb: Number(e.target.value) })} aria-label="Size limit" className="w-24">
          {MB_CHOICES.map((n) => <option key={n} value={n}>{n} MB</option>)}
        </Select>
        <Select value={who === "workspace" ? (r.compress ?? "off") : choice(r.compress)} disabled={disabled} onChange={(e) => save({ ...r, compress: (e.target.value || null) as SendRulesRow["compress"] })} aria-label="Compress PDFs" className="w-56">
          {who === "workspace" ? wsOpts : opts}
        </Select>
      </label>
      <label className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1">Turn Word files into PDF</span>
        <Select value={who === "workspace" ? (r.wordPdf ?? "off") : choice(r.wordPdf)} disabled={disabled} onChange={(e) => save({ ...r, wordPdf: (e.target.value || null) as SendRulesRow["wordPdf"] })} aria-label="Word to PDF" className="w-56">
          {who === "workspace" ? wsOpts : opts}
        </Select>
      </label>
    </div>
  );
}

/** Settings, General: the workspace rules (admins) and your own. Hidden when rules are off here. */
export function SendRulesSettings({ Section }: { Section: SectionCmp }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["tools-rules-settings"], retry: false, queryFn: async () => { try { return await api.get<RulesState>("/tools/rules"); } catch { return null; } } });
  const done = (r: RulesState) => { qc.setQueryData(["tools-rules-settings"], r); qc.setQueryData(["tools-rules"], r.effective); toast.success("Rule saved"); };
  const ws = useMutation({ mutationFn: (r: SendRulesRow) => api.put<RulesState>("/tools/rules/workspace", r), onSuccess: (r) => done({ ...r, canEditWorkspace: true }), onError: (e) => showError(e) });
  const mine = useMutation({ mutationFn: (r: SendRulesRow) => api.put<RulesState>("/tools/rules/mine", r), onSuccess: (r) => done({ ...r, canEditWorkspace: q.data?.canEditWorkspace ?? false }), onError: (e) => showError(e) });
  if (q.data === null) return null;
  const s = q.data;
  const wsWord = (v: "on" | "off" | null | undefined) => (v === "on" ? "on" : "off");
  return (
    <Section id="send-rules" title="Before sending" description="Big PDFs and Word files can be fixed in the email you are writing, before it goes. You see what changed and can undo it. If a file takes too long, the original is sent.">
      {!s ? <Skeleton className="h-16 w-full" /> : (
        <div className="space-y-5">
          {s.canEditWorkspace && (
            <div className="space-y-2">
              <h3 className="text-[13px] font-semibold">For everyone in this workspace</h3>
              <RuleRows who="workspace" row={s.workspace ?? empty} inherit={null} disabled={ws.isPending} onSave={(r) => ws.mutate(r)} />
            </div>
          )}
          <div className="space-y-2">
            <h3 className="text-[13px] font-semibold">Just for me</h3>
            <RuleRows who="mine" row={s.mine ?? empty} inherit={`${wsWord(s.workspace?.compress)}`} disabled={mine.isPending} onSave={(r) => mine.mutate(r)} />
            <p className="text-[12px] text-muted">Right now: {s.effective.compress ? `PDFs over ${s.effective.compressOverMb} MB are compressed` : "PDFs are sent as they are"}; {s.effective.wordPdf ? "Word files become PDFs." : "Word files are sent as they are."}</p>
          </div>
        </div>
      )}
    </Section>
  );
}
