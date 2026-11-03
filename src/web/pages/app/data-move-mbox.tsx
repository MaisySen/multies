/**
 * R40 mbox upload: Settings, Import and export, "Mail archive (.mbox)". The browser reads and splits the file (the
 * server's free plan allows little work per request), then sends 10 messages at a time with an Idempotency-Key each.
 * Messages already in the mailbox (same Message-ID) are skipped, so the same file can run twice safely.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { formatCount } from "@/web/lib/format-count";
import { useQueryClient } from "@tanstack/react-query";
import { IconCheckCircle, IconMail, IconUpload, IconWarning } from "@/web/components/ui/icon";
import { api, newIdempotencyKey } from "@/web/lib/api";
import { useConfig, useMailboxes } from "@/web/lib/queries";
import { Button } from "@/web/components/ui/button";
import { Field, Select } from "@/web/components/ui/input";
import { ErrorRetry } from "@/web/components/reconnecting-r40";
import { MBOX_MAX_FILE_MB, mboxBatches, splitMbox, toBase64 } from "@/web/lib/mbox-r40";

type Counts = { stored: number; duplicates: number; unreadable: number };
interface BatchAnswer { move: { id: string; status: string; done: number; total: number }; counts: Counts }
type Phase = "pick" | "reading" | "running" | "paused" | "done" | "stopped";

/** R43: the kept copy lets the server finish a run after the page closes. Its words change only once that is proven live
 * (the server's BACKGROUND_COPY, read from /api/config). */
export function useBackgroundCopy() { return !!useConfig().data?.backgroundCopy; }
const KEEP_MAX_BYTES = 100 * 1024 * 1024;
const PART_CHARS = 2_000_000;

/** Splits base64 messages into parts of about 2 MB (one message a line) with the first message index of each. */
export function keepParts(lines: string[], partChars = PART_CHARS) {
  const parts: string[][] = [];
  const starts: number[] = [];
  let size = 0;
  lines.forEach((l, i) => {
    if (!parts.length || (size + l.length > partChars && parts[parts.length - 1].length)) { parts.push([]); starts.push(i); size = 0; }
    parts[parts.length - 1].push(l);
    size += l.length + 1;
  });
  return { parts: parts.map((p) => p.join("\n")), starts };
}

export function MboxImport({ onClose, ring }: { onClose: () => void; ring: (value: number | null, label: string) => ReactNode }) {
  const qc = useQueryClient();
  const boxes = useMailboxes();
  const backgroundCopy = useBackgroundCopy();
  const input = useRef<HTMLInputElement>(null);
  const [mailboxId, setMailboxId] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("pick");
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Counts>({ stored: 0, duplicates: 0, unreadable: 0 });
  const [error, setError] = useState<unknown>(null);
  const batches = useRef<Uint8Array[][]>([]);
  const next = useRef(0);
  const moveId = useRef<string | null>(null);
  const keys = useRef<string[]>([]);
  const pause = useRef(false);
  const fileBytes = useRef(0);
  const [kept, setKept] = useState(false);

  useEffect(() => { if (!mailboxId && boxes.data?.length) setMailboxId(boxes.data[0].id); }, [boxes.data, mailboxId]);

  async function pick(f: File | undefined) {
    if (!f) return;
    setFileError(null);
    if (f.size > MBOX_MAX_FILE_MB * 1024 * 1024) { setFileError(`That file is ${Math.round(f.size / 1048576)} MB. Files up to ${MBOX_MAX_FILE_MB} MB work here: export one label or folder at a time.`); return; }
    setPhase("reading");
    setFileName(f.name);
    fileBytes.current = f.size;
    setKept(false);
    const msgs = splitMbox(new Uint8Array(await f.arrayBuffer()));
    if (!msgs.length) { setPhase("pick"); setFileError("No messages found in that file. Choose the .mbox file your mail app exported."); return; }
    batches.current = mboxBatches(msgs);
    keys.current = batches.current.map(() => newIdempotencyKey());
    next.current = 0;
    moveId.current = null;
    setTotal(msgs.length);
    setCounts({ stored: 0, duplicates: 0, unreadable: 0 });
    setPhase("paused");
  }

  async function run() {
    pause.current = false;
    setError(null);
    setPhase("running");
    while (next.current < batches.current.length) {
      if (pause.current) { setPhase("paused"); return; }
      const i = next.current;
      const last = i === batches.current.length - 1;
      try {
        const r = await api.post<BatchAnswer>("/data-moves/mbox/batch", {
          mailboxId, moveId: moveId.current, fileName, total, last, messages: batches.current[i].map(toBase64),
        }, { idempotencyKey: keys.current[i] });
        moveId.current = r.move.id;
        setCounts(r.counts);
        next.current = i + 1;
        if (i === 0 && !last) void keepRest(r.move.id);
      } catch (e) {
        setError(e);
        setPhase("paused");
        return;
      }
    }
    setPhase("done");
    void qc.invalidateQueries({ queryKey: ["data-moves"] });
  }

  /**
   * R43: after the first batch, upload the whole archive once (parts of about 2 MB) so the server can finish the run if
   * this page closes. Only for files up to 100 MB; a failed part just means the run waits for this page, as before.
   */
  async function keepRest(id: string) {
    if (fileBytes.current > KEEP_MAX_BYTES) return;
    try {
      const { parts, starts } = keepParts(batches.current.flat().map(toBase64));
      for (let p = 0; p < parts.length; p++) {
        if (pause.current && moveId.current !== id) return;
        const lastPart = p === parts.length - 1;
        const qs = new URLSearchParams({ part: String(p), parts: String(parts.length), ...(lastPart ? { starts: starts.join(","), mailboxId, folder: "INBOX" } : {}) });
        const r = await api.post<{ kept: boolean; reason: string | null }>(`/data-moves/mbox/${id}/keep?${qs}`, { lines: parts[p] });
        if (r.reason === "ended" || r.reason === "off") return;
        if (lastPart && r.kept) setKept(true);
      }
    } catch { /* the run carries on while this page is open */ }
  }

  async function cancel() {
    pause.current = true;
    if (moveId.current) { try { await api.post(`/data-moves/mbox/${moveId.current}/stop`, {}); } catch { /* the run stays in history as running */ } }
    setPhase("stopped");
    void qc.invalidateQueries({ queryKey: ["data-moves"] });
  }

  const done = counts.stored + counts.duplicates + counts.unreadable;
  const started = next.current > 0 || phase === "running";
  const value = phase === "reading" ? null : total ? done / total : 0;
  const box = boxes.data?.find((b) => b.id === mailboxId);

  return (
    <div className="space-y-4 rounded-2xl border border-line bg-surface p-4 shadow-[0_1px_3px_rgb(0_0_0/0.06)] sm:p-5" data-testid="mbox-import">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[11px] bg-[#0A84FF] text-white" aria-hidden><IconMail className="h-5 w-5" /></span>
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold leading-snug">Bring in a mail archive</h3>
          <p className="text-[13px] leading-relaxed text-muted">Gmail: Takeout, Mail, export. Apple Mail: select a mailbox, Mailbox menu, Export Mailbox. Messages already here are skipped, so running a file twice is safe.</p>
        </div>
      </div>

      {(phase === "pick" || phase === "reading") && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Into mailbox">
            {(p) => (
              <Select {...p} value={mailboxId} onChange={(e) => setMailboxId(e.target.value)} disabled={!boxes.data?.length}>
                {(boxes.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.address}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Archive file" hint={`An .mbox file up to ${MBOX_MAX_FILE_MB} MB. It is read on this device.`} error={fileError ?? undefined}>
            {(p) => (
              <div>
                <input ref={input} id={p.id} type="file" accept=".mbox,.mbx,.eml,application/mbox,message/rfc822" className="sr-only" aria-label="Mail archive file" onChange={(e) => void pick(e.target.files?.[0])} />
                <Button variant="outline" className="w-full justify-start" onClick={() => input.current?.click()} disabled={!mailboxId || phase === "reading"} aria-describedby={p["aria-describedby"]}>
                  <IconUpload className="h-4 w-4" aria-hidden />{phase === "reading" ? "Reading the file" : "Choose .mbox file"}
                </Button>
              </div>
            )}
          </Field>
          {!boxes.isLoading && !boxes.data?.length && <p className="text-[13px] text-muted sm:col-span-2">Add a mailbox first, then bring its old mail in here.</p>}
        </div>
      )}

      {phase !== "pick" && phase !== "reading" && (
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center">
          {ring(value, "Mail import progress")}
          <div className="min-w-0 flex-1 text-center sm:text-left" aria-live="polite">
            <p className="text-[15px] font-semibold tabular-nums" data-testid="mbox-progress">
              {phase === "done" ? `Done: ${formatCount(counts.stored)} ${counts.stored === 1 ? "message" : "messages"} brought in` : phase === "stopped" ? `Stopped at ${formatCount(done)} of ${formatCount(total)}` : `${formatCount(done)} of ${formatCount(total)} messages`}
            </p>
            <p className="truncate text-[13px] text-muted">{fileName} into {box?.address ?? "your mailbox"}</p>
            {(phase === "running" || (phase === "paused" && started)) && <p className="text-[13px] text-muted" data-testid="mbox-keep-open">{backgroundCopy && kept ? "You can close this page. It carries on by itself and we email you when it's done." : "Keep this page open until it finishes. If it closes, choose the same file again: messages already here are skipped."}</p>}
            {(counts.duplicates > 0 || counts.unreadable > 0) && (
              <p className="text-[13px] text-muted" data-testid="mbox-skipped">
                {counts.duplicates > 0 && `${counts.duplicates} already here`}{counts.duplicates > 0 && counts.unreadable > 0 && ", "}{counts.unreadable > 0 && `${counts.unreadable} could not be read`}
              </p>
            )}
          </div>
        </div>
      )}

      {Boolean(error) && <ErrorRetry error={error} onRetry={() => void run()} />}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
        {phase === "done" || phase === "stopped" ? (
          <>
            {phase === "done" && <span className="mr-auto inline-flex items-center gap-1.5 text-[13px] text-ok"><IconCheckCircle className="h-4 w-4" aria-hidden />In your mailbox now</span>}
            {phase === "stopped" && <span className="mr-auto inline-flex items-center gap-1.5 text-[13px] text-muted"><IconWarning className="h-4 w-4" aria-hidden />What came in stays</span>}
            <Button size="sm" variant="secondary" onClick={onClose}>Close</Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={() => void (started ? cancel() : onClose())}>Cancel</Button>
            {phase === "running" && <Button size="sm" variant="secondary" onClick={() => { pause.current = true; }} data-testid="mbox-pause">Pause</Button>}
            {phase === "paused" && <Button size="sm" onClick={() => void run()} data-testid="mbox-start">{started ? "Resume" : `Import ${total} ${total === 1 ? "message" : "messages"}`}</Button>}
          </>
        )}
      </div>
    </div>
  );
}
