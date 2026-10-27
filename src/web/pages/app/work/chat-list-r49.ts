/**
 * R49 mobile web: on a phone the chat screen is either the channel list or one channel, like a native messenger.
 * /app/chat with no channel opens the usual channel (general, else the first) except when the phone asked for the
 * list (Back from a channel goes to /app/chat?list=1). Wider screens always open a channel beside the list.
 */
export function shouldOpenDefaultChannel(o: { channelId?: string; hasDefault: boolean; listParam: string | null; phone: boolean }): boolean {
  if (o.channelId || !o.hasDefault) return false;
  return !(o.phone && o.listParam === "1");
}
