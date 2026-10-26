/** R36: short empty copy per mail folder (title under 4 words, one sentence of body; rea: files/teardowns/rea/clickup/empty-states-r36.md). */
const FOLDERS: Record<string, { title: string; body: string }> = {
  sent: { title: "Nothing sent yet", body: "Mail you send shows up here." },
  drafts: { title: "No drafts", body: "Mail you start and do not send waits here." },
  spam: { title: "No spam", body: "Mail that looks like junk lands here instead of your inbox." },
  trash: { title: "Trash is empty", body: "Deleted mail stays here until you empty it." },
  archive: { title: "Nothing archived", body: "Archive mail to clear your inbox without deleting it." },
  snoozed: { title: "Nothing snoozed", body: "Snoozed mail comes back to your inbox at the time you pick." },
  starred: { title: "No starred mail", body: "Star a message to find it here later." },
};

export function folderEmpty(folder: string): { title: string; body: string } {
  return FOLDERS[folder] ?? { title: "Nothing here", body: "Messages you move here will show up in this folder." };
}
