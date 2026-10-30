/**
 * R56 (MB-244): a reply draft saves itself a moment after typing stops, so a reload or a crash keeps it in Drafts.
 * One save at a time; edits made while a save is running go in the next one, which replaces the draft the last save
 * made (the drafts route stores a new copy and removes the old one), so a reply never leaves a second draft behind.
 */
export const AUTOSAVE_MS = 2500;

export interface Autosaver<T> {
  /** The latest content; a save follows `delayMs` after the last call. */
  change(value: T): void;
  /** Save now if anything is unsaved (page hidden or closing). */
  flush(): Promise<void>;
  /** Forget pending changes (sent or discarded) and return the draft id, if one was saved. */
  stop(): string | undefined;
  id(): string | undefined;
}

export function createAutosaver<T>(save: (value: T, id: string | undefined) => Promise<{ id: string }>, opts: { delayMs?: number; firstId?: string; onState?: (s: "saving" | "saved" | "failed") => void } = {}): Autosaver<T> {
  let id = opts.firstId;
  let pending: { value: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;
  const run = async (): Promise<void> => {
    if (running) { await running; if (pending && !stopped) return run(); return; }
    if (!pending || stopped) return;
    const { value } = pending; pending = null;
    opts.onState?.("saving");
    running = save(value, id).then((r) => { if (!stopped) { id = r.id; opts.onState?.("saved"); } }, () => { opts.onState?.("failed"); }).finally(() => { running = null; });
    await running;
    if (pending && !stopped) return run();
  };
  return {
    change(value) {
      if (stopped) return;
      pending = { value };
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void run(); }, opts.delayMs ?? AUTOSAVE_MS);
    },
    async flush() { if (timer) { clearTimeout(timer); timer = null; } await run(); },
    stop() { stopped = true; pending = null; if (timer) clearTimeout(timer); timer = null; return id; },
    id: () => id,
  };
}

/**
 * R67 (MB-244): a reply that was open when the page reloaded (or the tab crashed) opens again with its draft when the
 * same thread is opened in this browser. Compose remembers the draft it saved for a thread; Send, Close, and Discard
 * forget it. Kept for three days in this browser only.
 */
const OPEN_REPLY_KEY = "mm-open-reply-drafts";
const OPEN_REPLY_TTL_MS = 3 * 24 * 3600_000;
type OpenReplies = Record<string, { draftId: string; at: number }>;

function readOpenReplies(now = Date.now()): OpenReplies {
  try {
    const raw = JSON.parse(localStorage.getItem(OPEN_REPLY_KEY) ?? "{}") as OpenReplies;
    const out: OpenReplies = {};
    for (const [k, v] of Object.entries(raw)) if (v && typeof v.draftId === "string" && now - v.at < OPEN_REPLY_TTL_MS) out[k] = v;
    return out;
  } catch { return {}; }
}
function writeOpenReplies(v: OpenReplies) {
  try { if (Object.keys(v).length) localStorage.setItem(OPEN_REPLY_KEY, JSON.stringify(v)); else localStorage.removeItem(OPEN_REPLY_KEY); } catch { /* storage off: nothing to keep */ }
}
export function rememberOpenReply(threadId: string, draftId: string, now = Date.now()) {
  const all = readOpenReplies(now);
  all[threadId] = { draftId, at: now };
  writeOpenReplies(all);
}
export function forgetOpenReply(threadId: string | undefined) {
  if (!threadId) return;
  const all = readOpenReplies();
  if (!(threadId in all)) return;
  delete all[threadId];
  writeOpenReplies(all);
}
/** The draft of a reply that was still open in this thread when the page went away, if any. */
export function openReplyDraft(threadId: string | undefined, now = Date.now()): string | undefined {
  return threadId ? readOpenReplies(now)[threadId]?.draftId : undefined;
}
