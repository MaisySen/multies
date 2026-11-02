/**
 * TD1: "Matches by meaning" in Ctrl K (ASK_TD1). Close words and, when the workspace's own key allows, meaning; only items
 * the person can open. Items already listed above are left out. Waits 350 ms after typing stops.
 */
import { useEffect, useState } from "react";
import { Command } from "cmdk";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/web/lib/api";

interface MeaningItem { type: string; id: string; title: string; subtitle: string; url: string }

export function useMeaningSearch(q: string, enabled: boolean) {
  const [debounced, setDebounced] = useState(q.trim());
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 350); return () => clearTimeout(t); }, [q]);
  return useQuery({
    queryKey: ["ask-meaning", debounced], enabled: enabled && debounced.length >= 3, staleTime: 30_000, retry: false,
    queryFn: () => api.get<{ mode: string; items: MeaningItem[] }>(`/ask/search?q=${encodeURIComponent(debounced)}`),
  });
}

export function MeaningGroup({ q, enabled, exclude, heading, className, onOpen }: {
  q: string; enabled: boolean; exclude: Set<string>; heading: React.ReactNode; className: string; onOpen: (url: string, title: string) => void;
}) {
  const r = useMeaningSearch(q, enabled);
  const items = (r.data?.items ?? []).filter((i) => !exclude.has(`${i.type}:${i.id}`)).slice(0, 5);
  if (!enabled || !items.length) return null;
  return (
    <Command.Group forceMount heading={heading} className={className} data-testid="palette-meaning">
      {items.map((i) => (
        <Command.Item key={`${i.type}:${i.id}`} forceMount value={`${q}|meaning|${i.type}:${i.id}`} onSelect={() => onOpen(i.url, i.title)}
          className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-[13.5px] text-fg transition-colors duration-150 data-[selected=true]:bg-hover motion-reduce:transition-none max-sm:min-h-[44px]">
          <span className="min-w-0 flex-1 truncate">{i.title}</span>
          {i.subtitle && <span className="shrink-0 truncate text-xs text-subtle max-sm:hidden">{i.subtitle}</span>}
        </Command.Item>
      ))}
    </Command.Group>
  );
}
