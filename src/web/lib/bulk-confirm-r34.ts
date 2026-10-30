/**
 * R34: "select all" jobs over a lot of mail ask first. The words of the confirm before a big job, and which server
 * job a bar action becomes in "everything" mode (delete there is a move to Trash, so it can be undone).
 */
import type { BulkAction } from "./mail-selection";

/** Jobs over this many messages ask first (or any job whose total isn't known up front). */
export const BIG_JOB = 500;
export type JobAction = "read" | "unread" | "star" | "unstar" | "archive" | "inbox" | "spam" | "trash" | "snooze" | "move";

/** The job a bar action runs over everything, or null when it can't run as a job (delete forever inside Trash). */
export function jobActionFor(action: BulkAction, folder: string): JobAction | null {
  if (action === "delete") return folder === "trash" ? null : "trash";
  if (action === "unsnooze") return null;
  return action;
}

/** True when the job should ask first. `count` is null when the total isn't known (a search, a provider folder). */
export const needsConfirm = (count: number | null, more: boolean) => (count === null ? more : count > BIG_JOB);

const VERB: Record<JobAction, string> = {
  read: "Mark", unread: "Mark", star: "Star", unstar: "Unstar", archive: "Archive", inbox: "Move", spam: "Mark", trash: "Delete", snooze: "Snooze", move: "Move",
};
const TAIL: Partial<Record<JobAction, string>> = { read: " as read", unread: " as unread", inbox: " to Inbox", spam: " as spam" };

/** "Archive 3,100 messages in Inbox?" plus the line under it and the button. */
export function jobConfirmWords(action: JobAction, count: number | null, where: string, extra?: string) {
  const n = count === null ? "every message" : `${count.toLocaleString("en-US")} ${count === 1 ? "message" : "messages"}`;
  const place = where ? (where.startsWith("“") ? ` matching ${where}` : ` in ${where}`) : "";
  const tail = action === "move" && extra ? ` to ${extra}` : action === "snooze" && extra ? ` until ${extra}` : TAIL[action] ?? "";
  const title = `${VERB[action]} ${n}${place}${tail}?`;
  const description = action === "move"
    ? "This might take a minute. Moves to a synced folder can't be undone."
    : action === "trash" ? "They go to Trash. This might take a minute. You can undo it." : "This might take a minute. You can undo it.";
  return { title, description, button: VERB[action] };
}
