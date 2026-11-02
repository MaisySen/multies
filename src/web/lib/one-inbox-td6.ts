/** TD6 One inbox: the nav badge (unread Important), read once a minute while the page is open and the flag is on. */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/web/lib/api";

export const ONE_INBOX_PATH = "/app/one-inbox";

export function useOneInboxCount(enabled: boolean) {
  return useQuery({
    queryKey: ["one-inbox", "count"], enabled, refetchInterval: 60_000, staleTime: 30_000, retry: false,
    queryFn: async () => (await api.get<{ unread: number }>("/one-inbox/count")).unread,
  });
}
