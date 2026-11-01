/** R112: the message thread shared by the reporter's page and the handler's case view. */
import { useRef, useState } from "react";
import { Button } from "@/web/components/ui/button";
import { Textarea } from "@/web/components/ui/input";
import { IconFile, IconLock, IconSend } from "@/web/components/ui/icon";
import { LOCALE } from "@/shared/locale";
import { REPORT_LIMITS, type ReportMessageView } from "@/shared/reporting-r112";

export const when = (t: number) => new Date(t).toLocaleString(LOCALE, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
export const day = (t: number) => new Date(t).toLocaleDateString(LOCALE, { day: "numeric", month: "short", year: "numeric" });
export const sizeText = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`);

export function Thread({ messages, viewer, onFile }: { messages: ReportMessageView[]; viewer: "reporter" | "handler"; onFile: (fileId: string, name: string) => void }) {
  return (
    <ol className="space-y-3" aria-label="Messages" data-testid="report-thread">
      {messages.map((m) => {
        const mine = (viewer === "reporter" && m.author === "reporter") || (viewer === "handler" && m.author === "handler");
        if (m.author === "system") {
          return <li key={m.id} className="text-center text-[12.5px] text-muted">{m.body} <span className="text-subtle">· {when(m.createdAt)}</span>{m.internal && <span className="text-subtle"> · only handlers see this</span>}</li>;
        }
        const who = m.author === "reporter" ? (viewer === "reporter" ? "You" : "Reporter") : viewer === "reporter" ? "Handler" : (m.authorName ?? "Handler");
        return (
          <li key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`} data-testid={m.internal ? "internal-note" : "message"}>
            <div className={`max-w-[85%] rounded-2xl border px-4 py-3 text-[14px] ${m.internal ? "border-warn/30 bg-warn-soft" : mine ? "border-line bg-fill" : "border-line bg-elevated"}`}>
              <div className="mb-1 flex flex-wrap items-center gap-x-2 text-[12px] text-muted">
                <span className="font-medium text-fg">{who}</span>
                <span>{when(m.createdAt)}</span>
                {m.internal && <span className="inline-flex items-center gap-1"><IconLock className="h-3.5 w-3.5" />Internal note, only handlers see this</span>}
              </div>
              {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
              {m.files.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-2">
                  {m.files.map((f) => (
                    <li key={f.id}>
                      <button type="button" onClick={() => onFile(f.id, f.name)} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[12.5px] hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:min-h-11">
                        <IconFile className="h-4 w-4" />{f.name}<span className="text-subtle">{sizeText(f.size)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Reply box with optional files. Ctrl Enter sends. */
export function Composer({ onSend, placeholder, busy, internalToggle, testid = "reply" }: {
  onSend: (text: string, files: File[], internal: boolean) => Promise<boolean>; placeholder: string; busy: boolean; internalToggle?: boolean; testid?: string;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [internal, setInternal] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const send = async () => { if (await onSend(text, files, internal)) { setText(""); setFiles([]); setInternal(false); if (input.current) input.current.value = ""; } };
  const ok = (text.trim().length > 0 || files.length > 0) && text.length <= REPORT_LIMITS.replyChars;
  return (
    <div className={`rounded-2xl border p-3 ${internal ? "border-warn/30 bg-warn-soft" : "border-line bg-elevated"}`}>
      <label htmlFor={`${testid}-text`} className="sr-only">{placeholder}</label>
      <Textarea id={`${testid}-text`} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} className="min-h-24 border-0 bg-transparent p-1 focus-visible:ring-0" data-testid={`${testid}-text`}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && ok && !busy) { e.preventDefault(); void send(); } }} />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] hover:bg-fill focus-within:ring-2 focus-within:ring-brand max-sm:min-h-11">
          <IconFile className="h-4 w-4" />Attach files
          <input ref={input} type="file" multiple className="sr-only" onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, REPORT_LIMITS.filesPerMessage))} data-testid={`${testid}-files`} />
        </label>
        {files.length > 0 && <span className="text-[12.5px] text-muted">{files.map((f) => f.name).join(", ")}</span>}
        {internalToggle && (
          <label className="inline-flex min-h-9 items-center gap-2 text-[13px] max-sm:min-h-11">
            <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} className="h-4 w-4 accent-brand" data-testid="internal-toggle" />Internal note
          </label>
        )}
        <Button className="ml-auto" onClick={() => void send()} loading={busy} disabled={!ok} data-testid={`${testid}-send`}><IconSend className="h-4 w-4" />{internal ? "Save note" : "Send"}</Button>
      </div>
    </div>
  );
}
