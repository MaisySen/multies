import { useEffect } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { Button, EmptyState, Loading } from "@/components/ui";
import { useSession } from "@/lib/session";
import { useQuery } from "@tanstack/react-query";

/**
 * Opens a chat message from a push or a notification: looks it up, then shows its channel, and
 * the thread on top when the message is a reply.
 */
export default function ChatMessageLink() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useSession();
  const q = useQuery({ queryKey: ["chat", "message", id], queryFn: () => api.chatMessage(id), enabled: !!id });
  useEffect(() => {
    if (!q.data) return;
    const { message } = q.data;
    router.replace({ pathname: "/chat/[id]", params: message.parentId ? { id: message.channelId, thread: message.parentId } : { id: message.channelId } });
  }, [q.data]);
  if (q.error) return <EmptyState icon="message-circle" title="Couldn't open that message" body={q.error.message} action={<Button label="Back" variant="secondary" onPress={() => router.back()} />} />;
  return <Loading label="Opening message" />;
}
