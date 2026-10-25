/**
 * Phone layout helpers (R25, DF-10): which Tasks view opens by default, and the chat composer's hint line.
 * Kept free of React so the choices are unit tested (tests/phone-r25.test.ts).
 */

export const TASK_VIEWS = ["board", "list", "calendar", "timeline", "sprints", "workload"] as const;
export type TaskViewId = (typeof TASK_VIEWS)[number];

/** Where the last view a person picked on this device is kept. */
export const TASK_VIEW_KEY = "multies:tasks-view";

/** Phone widths: the same breakpoint as Tailwind's `sm` (640 px). */
export const PHONE_QUERY = "(max-width: 639px)";
/** A touch screen with no hover: phones and tablets, where keyboard hints mean nothing. */
export const TOUCH_QUERY = "(hover: none) and (pointer: coarse)";

const isView = (v: unknown): v is TaskViewId => typeof v === "string" && (TASK_VIEWS as readonly string[]).includes(v);

/**
 * The view Tasks opens with. A view in the address wins, then the view this person last picked on
 * this device; with neither, phones get the List (a board's second column runs off a 390 px screen)
 * and wider screens get the Board.
 */
export function pickTaskView(input: { param?: string | null; stored?: string | null; phone: boolean }): TaskViewId {
  if (isView(input.param)) return input.param;
  if (isView(input.stored)) return input.stored;
  return input.phone ? "list" : "board";
}

function matches(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}
export const isPhoneWidth = () => matches(PHONE_QUERY);
export const isTouchOnly = () => matches(TOUCH_QUERY);

export function readStoredTaskView(): string | null {
  try { return typeof localStorage === "undefined" ? null : localStorage.getItem(TASK_VIEW_KEY); } catch { return null; }
}
/** Remember an explicit pick (a tap on a view tab), so the next visit opens the same view. */
export function storeTaskView(view: string): void {
  if (!isView(view)) return;
  try { localStorage.setItem(TASK_VIEW_KEY, view); } catch { /* private mode: the address still carries it */ }
}

/**
 * The line under the chat composer. Keyboard hints only where there is a keyboard; the sample task
 * ref uses a project key that really exists in this workspace, or no sample at all.
 */
export function composerHint(input: { touch: boolean; projectKey?: string | null }): string {
  const key = input.projectKey && /^[A-Z][A-Z0-9]{1,5}$/.test(input.projectKey) ? input.projectKey : null;
  const refs = key ? `a task ref like ${key}-1 to link it` : "a task ref to link it";
  const tail = `Type @ to mention, or ${refs}.`;
  return input.touch ? tail : `Enter to send, Shift Enter for a new line. ${tail}`;
}
