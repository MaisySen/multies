/**
 * Tools P2: the one way to "Attach to a new email". Every Tools surface (Tools results, batch, auto redact,
 * page editor, forms, compare, AI results, templates, workflows, share links) calls attachToNewEmail, or the
 * useAttachToNewEmail hook, and Mail opens a new message with everything in one attachment row.
 *
 * Two kinds of attachment ride along:
 * - engine results as download tokens (ToolFileRef): nothing is downloaded or uploaded again, the server reads
 *   each result from the document engine when the email is sent (results are kept there for an hour);
 * - local files (File): kept in this tab's memory and sent as base64 with the email.
 * Prefer tokens for engine results and files for anything made or picked in the browser.
 * One limit for both: COMPOSE_ATTACH_MAX_FILES files and COMPOSE_ATTACH_MAX_BYTES per email (the server checks the same).
 */
import { useNavigate } from "react-router";
import { COMPOSE_ATTACH_MAX_FILES } from "@/shared/tools-automation";

export interface ToolFileRef { token: string; name: string; bytes?: number }

export interface PendingCompose { files?: File[]; toolFiles?: ToolFileRef[]; subject?: string; text?: string; to?: string }

/** What to attach: local files, engine result tokens, or finished jobs (their tokens are read from downloadUrl). */
export interface AttachInput {
  files?: File[];
  tools?: ToolFileRef[];
  jobs?: { downloadUrl?: string; name: string; bytes?: number }[];
}

let pending: PendingCompose | null = null;

/** The download token inside a result's downloadUrl ("/api/tools/jobs/<token>/download", or the editors' "/api/tools/editors/jobs/<token>/download"; both carry the same signed token). */
export function tokenFromDownloadUrl(url: string): string | null {
  const m = /\/api\/tools\/(?:editors\/)?jobs\/([^/]+)\/download$/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Finished jobs as token attachments (jobs without a token are skipped). */
export function toolFileRefs(jobs: { downloadUrl?: string; name: string; bytes?: number }[]): ToolFileRef[] {
  const out: ToolFileRef[] = [];
  for (const j of jobs) {
    const token = j.downloadUrl ? tokenFromDownloadUrl(j.downloadUrl) : null;
    if (token) out.push({ token, name: j.name, bytes: j.bytes });
  }
  return out.slice(0, COMPOSE_ATTACH_MAX_FILES);
}

/** Opens Mail with a new message carrying these attachments (and an optional subject, text or recipient). */
export function attachToNewEmail(navigate: (to: string) => void, att: AttachInput, draft: Omit<PendingCompose, "files" | "toolFiles"> = {}): void {
  const toolFiles = [...(att.tools ?? []), ...toolFileRefs(att.jobs ?? [])];
  const seen = new Set<string>();
  const tokens = toolFiles.filter((t) => (seen.has(t.token) ? false : (seen.add(t.token), true)));
  const files = att.files ?? [];
  // One limit across both kinds; the composer says so if anything was left out.
  const room = COMPOSE_ATTACH_MAX_FILES;
  const keptTokens = tokens.slice(0, room);
  const keptFiles = files.slice(0, Math.max(0, room - keptTokens.length));
  pending = { ...draft, toolFiles: keptTokens, files: keptFiles };
  navigate("/app/mail?compose=files");
}

/** The same, as a hook for components. */
export function useAttachToNewEmail() {
  const navigate = useNavigate();
  return (att: AttachInput, draft: Omit<PendingCompose, "files" | "toolFiles"> = {}) => attachToNewEmail(navigate, att, draft);
}

/** Mail takes what is waiting for a new message, once. */
export function takePendingCompose(): PendingCompose | null {
  const p = pending;
  pending = null;
  return p;
}

/** Reads a File as base64 (no data: prefix) for the send request. */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
