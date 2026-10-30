/**
 * R31: mail actions by name, for the one command registry (Cmd+K, single keys, the ? sheet). The mail page
 * registers its handlers while it is open (webmail.tsx: list actions; the reader: reply, reply all, forward);
 * the registry calls runMailAction("archive") and gets false when nothing on screen can do it.
 */
export const MAIL_ACTIONS = ["archive", "trash", "star", "reply", "replyAll", "forward", "next", "prev", "compose", "search", "close", "nextSplit", "prevSplit", "markUnread"] as const;
export type MailActionName = (typeof MAIL_ACTIONS)[number];
type Handlers = Partial<Record<MailActionName, () => void>>;

const layers: Handlers[] = [];

/** Adds handlers; later layers win (the reader over the list). Returns the function that removes them. */
export function registerMailActions(h: Handlers): () => void {
  layers.push(h);
  return () => { const i = layers.lastIndexOf(h); if (i >= 0) layers.splice(i, 1); };
}

export function canRunMailAction(name: MailActionName): boolean {
  return layers.some((l) => typeof l[name] === "function");
}

/** Runs a mail action if the mail page can; false when it is not open or the action does not apply. */
export function runMailAction(name: MailActionName): boolean {
  for (let i = layers.length - 1; i >= 0; i--) {
    const fn = layers[i][name];
    if (fn) { fn(); return true; }
  }
  return false;
}
