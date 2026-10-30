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
