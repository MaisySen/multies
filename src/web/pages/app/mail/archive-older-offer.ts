/**
 * R46: when "Archive older mail" is offered. The job always covers the whole Inbox (every split tab), so an empty tab
 * (Important with nothing in it while Other has mail) still offers it when the mailbox Inbox holds mail. Before R46 the
 * button looked only at the rows of the open tab and vanished there.
 */
export function archiveOlderOffered(o: { folder: string; q: string; loaded: number; inboxTotal: number }): boolean {
  if (o.folder !== "inbox" || o.q) return false;
  return o.loaded > 0 || o.inboxTotal > 0;
}

/** R46: the empty Inbox title. An empty tab while other tabs hold mail is not "Inbox zero". */
export function emptyInboxTitle(o: { split: string; defaultSplit: string; tabs: number; inboxTotal: number }): string {
  if (o.split && o.split !== o.defaultSplit) return "Nothing in this tab";
  if (o.tabs > 0 && o.inboxTotal > 0) return "Nothing in this tab";
  return "Inbox zero";
}

/** R46: the count line in the sheet. With split tabs on, it says the count covers every tab, so it stays true on a tab. */
export function olderCountWords(total: number, max: number, everyTab: boolean): string {
  if (total === 0) return everyTab ? "Nothing in your Inbox is that old, in any tab." : "Nothing in your Inbox is that old.";
  const tail = everyTab ? ", counted across every Inbox tab." : ".";
  if (total > max) return `${total.toLocaleString()} emails${everyTab ? " across every Inbox tab" : ""}. The oldest ${max.toLocaleString()} move now; run it again for the rest.`;
  return `${total.toLocaleString()} ${total === 1 ? "email moves" : "emails move"} to Archive${tail}`;
}
