/**
 * Tools P2: attachments in the composer, and the auto rules that run on them before sending.
 * A rule (Settings or Tools, "Before sending") compresses big PDFs or turns Word files into PDFs right
 * here in the composer: the Tools job runs, the attachment is swapped, and a chip says what happened
 * with an Undo. A slow or failed job leaves the original and a plain note; Send is never held for it.
 * Tools results handed over by "Attach to a new email" (lib/compose-files) sit in the same row as tokens:
 * the server reads them from the engine at send time. One limit covers both kinds: 10 files, 20 MB.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { runToolOnFile } from "@/web/lib/tool-jobs";
import type { ToolFileRef } from "@/web/lib/compose-files";
import { IconClose, IconFile, IconUndo } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";
import { COMPOSE_ATTACH_MAX_BYTES, COMPOSE_ATTACH_MAX_FILES, formatMb, ruleFor, type SendRules } from "@/shared/tools-automation";
import { tr } from "@/web/i18n"; // R104B
import "@/web/i18n/w2/en-compose"; // R104B

export interface ComposeFile {
  id: string;
  file: File;
  /** The file before a rule changed it (Undo puts it back). */
  original?: File;
  state: "ready" | "working";
  /** "Compressed by your rule, 4.1 MB to 0.9 MB" */
  chip?: string;
  /** A plain note when a rule could not run. */
  note?: string;
}

/** How long a rule may take before the original stays attached. */
export const RULE_TIMEOUT_MS = 45_000;

const sizeOf = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : formatMb(n));
let seq = 0;
const nextId = () => `f${++seq}`;

/** The rules that apply to this person; null when rules are off here (flag, switch or Tools off). */
export function useSendRules() {
  const q = useQuery({
    queryKey: ["tools-rules"], staleTime: 60_000, retry: false,
    queryFn: async () => { try { return (await api.get<{ effective: SendRules }>("/tools/rules")).effective; } catch { return null; } },
  });
  return q.data ?? null;
}

export function useComposeFiles(initial: File[] | undefined, initialTools: ToolFileRef[] = []) {
  const rules = useSendRules();
  const [items, setItems] = useState<ComposeFile[]>(() => (initial ?? []).map((file) => ({ id: nextId(), file, state: "ready" as const })));
  /** Tools results (engine tokens); the server fetches them when the email goes. */
  const [tools, setTools] = useState<ToolFileRef[]>(() => initialTools.slice(0, COMPOSE_ATTACH_MAX_FILES));
  const toolBytes = tools.reduce((a, t) => a + (t.bytes ?? 0), 0);
  const aborts = useRef(new Map<string, AbortController>());
  useEffect(() => () => { for (const a of aborts.current.values()) a.abort(); }, []);
  const patch = (id: string, p: Partial<ComposeFile>) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)));

  const applyRule = (item: ComposeFile, r: SendRules) => {
    const op = ruleFor(r, { name: item.file.name, type: item.file.type, size: item.file.size });
    if (!op) return;
    const ctl = new AbortController();
    aborts.current.set(item.id, ctl);
    patch(item.id, { state: "working", note: undefined });
    const before = item.file;
    runToolOnFile(op, before, {}, { timeoutMs: RULE_TIMEOUT_MS, signal: ctl.signal })
      .then((out) => {
        if (ctl.signal.aborted) return;
        if (op === "compress" && out.size >= before.size) { patch(item.id, { state: "ready", note: "Already as small as it gets, so the original is attached." }); return; }
        const named = new File([out], op === "convert" ? before.name.replace(/\.[^.]+$/, "") + ".pdf" : before.name, { type: "application/pdf" });
        patch(item.id, {
          state: "ready", file: named, original: before,
          chip: op === "compress" ? `Compressed by your rule, ${sizeOf(before.size)} to ${sizeOf(named.size)}` : "Turned into a PDF by your rule",
        });
      })
      .catch(() => {
        if (ctl.signal.aborted) return;
        patch(item.id, { state: "ready", note: op === "compress" ? "Your rule couldn't compress this file just now, so the original is attached." : "Your rule couldn't turn this into a PDF just now, so the original is attached." });
      })
      .finally(() => aborts.current.delete(item.id));
  };

  // Files that arrived before the rules loaded get them once they do.
  const ruled = useRef(new Set<string>());
  useEffect(() => {
    if (!rules) return;
    for (const it of items) if (!ruled.current.has(it.id) && it.state === "ready" && !it.original) { ruled.current.add(it.id); applyRule(it, rules); }
  }, [rules, items]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = (files: File[]) => {
    const total = toolBytes + items.reduce((a, x) => a + x.file.size, 0) + files.reduce((a, f) => a + f.size, 0);
    if (tools.length + items.length + files.length > COMPOSE_ATTACH_MAX_FILES) { toast.error(`You can attach up to ${COMPOSE_ATTACH_MAX_FILES} files.`); return; }
    // Rules may shrink big PDFs, so only refuse what no rule can bring under the limit.
    if (total > COMPOSE_ATTACH_MAX_BYTES && !files.some((f) => rules && ruleFor(rules, { name: f.name, type: f.type, size: f.size }) === "compress")) {
      toast.error(tr("compose.attachments_can_add_up_to_compose_attach_max_byt", { COMPOSE_ATTACH_MAX_BYTES: formatMb(COMPOSE_ATTACH_MAX_BYTES) }), { description: tr("compose.a_share_link_suits_bigger_files") });
      return;
    }
    setItems((xs) => [...xs, ...files.map((file) => ({ id: nextId(), file, state: "ready" as const }))]);
  };
  const removeTool = (token: string) => setTools((ts) => ts.filter((t) => t.token !== token));
  const remove = (id: string) => { aborts.current.get(id)?.abort(); ruled.current.add(id); setItems((xs) => xs.filter((x) => x.id !== id)); };
  const undo = (id: string) => setItems((xs) => xs.map((x) => (x.id === id && x.original ? { ...x, file: x.original, original: undefined, chip: undefined, note: undefined } : x)));
  /** What Send takes: the current file of each item. A rule still running is stopped and the original goes. */
  const forSend = () => {
    for (const a of aborts.current.values()) a.abort();
    return items.map((x) => x.file);
  };
  /** Every attachment, both kinds. */
  const count = items.length + tools.length;
  return { items, tools, count, add, remove, removeTool, undo, forSend, rulesOn: !!rules };
}

export function AttachmentChips({ c }: { c: ReturnType<typeof useComposeFiles> }) {
  if (!c.count) return null;
  return (
    <ul data-testid="compose-attachments" aria-label={tr("compose.attachments")} className="flex shrink-0 flex-col gap-1.5 border-t border-line px-4 py-2">
      {c.tools.map((t) => (
        <li key={t.token} data-testid="compose-tool-file" className="flex min-w-0 items-center gap-2 text-[13px]">
          <IconFile className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 truncate font-medium">{t.name}</span>
          {t.bytes ? <span className="shrink-0 text-subtle">{sizeOf(t.bytes)}</span> : null}
          <span className="shrink-0 text-[12px] text-subtle">{tr("compose.from_tools")}</span>
          <button type="button" onClick={() => c.removeTool(t.token)} aria-label={tr("compose.remove_name", { name: t.name })} className="ml-auto inline-flex shrink-0 items-center justify-center rounded-md p-1 text-muted hover:bg-hover hover:text-fg max-sm:h-11 max-sm:w-11"><IconClose className="h-3.5 w-3.5" /></button>
        </li>
      ))}
      {c.items.map((it) => (
        <li key={it.id} className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2 text-[13px]">
            <IconFile className="h-4 w-4 shrink-0 text-muted" aria-hidden />
            <span className="min-w-0 truncate font-medium">{it.file.name}</span>
            <span className="shrink-0 text-subtle">{sizeOf(it.file.size)}</span>
            {it.state === "working" && <span role="status" className="shrink-0 text-[12px] text-muted">{tr("compose.applying_your_rule")}</span>}
            <button type="button" onClick={() => c.remove(it.id)} aria-label={tr("compose.remove_name", { name: it.file.name })} className="ml-auto inline-flex shrink-0 items-center justify-center rounded-md p-1 text-muted hover:bg-hover hover:text-fg max-sm:h-11 max-sm:w-11"><IconClose className="h-3.5 w-3.5" /></button>
          </div>
          {it.chip && (
            <div data-testid="rule-chip" className="flex items-center gap-2 pl-6">
              <span className="rounded-full bg-[#34C759]/[0.12] px-2 py-0.5 text-[12px] text-fg">{it.chip}</span>
              <button type="button" onClick={() => c.undo(it.id)} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-brand-hover hover:bg-hover max-sm:min-h-11"><IconUndo className="h-3 w-3" aria-hidden />{tr("compose.undo")}</button>
            </div>
          )}
          {it.note && <p data-testid="rule-note" className="pl-6 text-[12px] text-muted">{it.note}</p>}
        </li>
      ))}
    </ul>
  );
}

export function AttachButton({ c, className }: { c: ReturnType<typeof useComposeFiles>; className?: string }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={input} type="file" multiple hidden data-testid="compose-file-input" onChange={(e) => { const fs = [...(e.target.files ?? [])]; if (fs.length) c.add(fs); e.target.value = ""; }} />
      <button type="button" onClick={() => input.current?.click()} aria-label={tr("compose.attach_files")} title={c.rulesOn ? tr("compose.attach_files_your_rules_run_before_sending") : tr("compose.attach_files")}
        className={cn("inline-flex items-center justify-center rounded-md p-2 text-muted hover:bg-hover hover:text-fg max-sm:h-11 max-sm:w-11", className)}>
        <PaperclipIcon />
      </button>
    </>
  );
}

function PaperclipIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m21 11.5-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l9-9a3.7 3.7 0 0 1 5.2 5.2l-9 9a1.8 1.8 0 0 1-2.6-2.6l8.3-8.3" />
    </svg>
  );
}
