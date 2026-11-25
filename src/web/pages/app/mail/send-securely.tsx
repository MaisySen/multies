/**
 * R88: "Send securely" in Mail compose. Locks the selected text (or one attached file) on this device as a secret link
 * and puts the link in the message where the text was, so the secret itself never travels in the email.
 * Shown while GET /api/tools lists the "secrets" feature.
 */
import { useState, type RefObject } from "react";
import { toast } from "sonner";
import { Dialog } from "@/web/components/ui/dialog";
import { IconLock } from "@/web/components/ui/icon";
import { useToolFeatureList } from "@/web/components/tools/use-tools-info";
import { SecretForm, type MadeSecret } from "@/web/pages/app/tools-share-sign/secrets-tab";
import { SECRET_MAX_FILE_BYTES } from "@/shared/secure-share";
import type { ComposeFile } from "./compose-attachments";

export function SendSecurelyButton({ bodyRef, text, files, onText, onRemoveFile }: {
  bodyRef: RefObject<HTMLTextAreaElement | null>; text: string; files: ComposeFile[];
  onText: (next: string, cursor: number) => void; onRemoveFile: (id: string) => void;
}) {
  const on = useToolFeatureList().includes("secrets");
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const [fileId, setFileId] = useState<string | null>(null);
  if (!on) return null;
  const small = files.filter((f) => f.state === "ready" && f.file.size <= SECRET_MAX_FILE_BYTES);
  const picked = small.find((f) => f.id === fileId) ?? null;
  const selected = text.slice(sel.start, sel.end);

  const start = () => {
    const el = bodyRef.current;
    const s = el ? { start: el.selectionStart ?? text.length, end: el.selectionEnd ?? text.length } : { start: text.length, end: text.length };
    setSel(s);
    setFileId(s.end > s.start ? null : small[0]?.id ?? null);
    setOpen(true);
  };
  const made = (m: MadeSecret) => {
    const line = `Secure link (opens ${m.info.maxViews === 1 ? "once" : `${m.info.maxViews} times`}): ${m.link}`;
    const at = picked ? sel.end : sel.start;
    const before = text.slice(0, at), after = text.slice(sel.end);
    const pad = before && !/\s$/.test(before) ? " " : "";
    const next = `${before}${pad}${line}${after && !/^\s/.test(after) ? " " : ""}${after}`;
    onText(next, (before + pad + line).length);
    if (picked) onRemoveFile(picked.id);
    setOpen(false);
    toast.success(picked ? "Secure link added and the file removed from the email" : "Secure link added", { description: m.info.hasPassphrase ? "Send the passphrase another way, like a call or a text." : "The secret itself is not in the email." });
  };

  return (
    <>
      <button type="button" onClick={start} title="Lock text or a small file as a secret link that deletes itself" data-testid="compose-send-securely"
        className="inline-flex items-center justify-center gap-1.5 rounded-md p-2 text-[12.5px] text-muted hover:bg-hover hover:text-fg max-sm:h-11 max-sm:w-11">
        <IconLock className="h-4 w-4" aria-hidden /><span className="max-lg:sr-only">Secure link</span>
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Send securely" description="It is locked on this device and goes as a link that deletes itself after it is opened. The secret is never in the email.">
        <div className="space-y-4 pb-1 pt-1">
          {small.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-[13px]" role="group" aria-label="What to lock">
              <span className="text-muted">Lock:</span>
              <button type="button" aria-pressed={!picked} onClick={() => setFileId(null)} className={`h-8 rounded-full border px-3 max-sm:min-h-11 ${!picked ? "border-brand bg-brand-soft font-medium text-brand-hover" : "border-line-strong hover:bg-hover"}`}>{selected ? "Selected text" : "Text"}</button>
              {small.map((f) => (
                <button key={f.id} type="button" aria-pressed={picked?.id === f.id} onClick={() => setFileId(f.id)} title={f.file.name}
                  className={`h-8 max-w-[220px] truncate rounded-full border px-3 max-sm:min-h-11 ${picked?.id === f.id ? "border-brand bg-brand-soft font-medium text-brand-hover" : "border-line-strong hover:bg-hover"}`}>{f.file.name}</button>
              ))}
            </div>
          )}
          <SecretForm key={picked?.id ?? "text"} compact initialText={selected} initialFile={picked?.file ?? null} onMade={made} submitLabel="Add secure link" />
        </div>
      </Dialog>
    </>
  );
}
