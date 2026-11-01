/** The content groups in the command menu (round 20): results from /api/search, opened at their real URL. */
import { Command } from "cmdk";
import { IconAttachment, IconBriefcase, IconContacts, IconDocs, IconFile, IconInbox, IconMessageCircle, IconStickyNote, IconTasks } from "@/web/components/ui/icon";
import { Spinner } from "@/web/components/ui/spinner";
import type { SearchType, useContentSearch as UseContentSearch } from "@/web/lib/search";

export { useContentSearch } from "@/web/lib/search";

const ICONS: Record<SearchType, React.ComponentType<{ className?: string }>> = {
  mail: IconInbox, tasks: IconTasks, docs: IconDocs, chat: IconMessageCircle, contacts: IconContacts, deals: IconBriefcase, attachments: IconAttachment, files: IconFile, notes: IconStickyNote, // R98
};

const groupClass = "px-1.5 pb-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-subtle";

export function ContentGroups({ state, search, onOpen }: { state: ReturnType<typeof UseContentSearch>; search: string; onOpen: (url: string, title?: string) => void }) {
  if (!state.active) return null;
  const groups = state.data?.groups ?? [];
  return (
    <>
      {state.loading && !groups.length && (
        <Command.Loading>
          <div className="flex items-center gap-2 px-4 py-3 text-[13px] text-muted" data-testid="search-loading"><Spinner className="h-3.5 w-3.5" />Searching mail, tasks, docs and chat</div>
        </Command.Loading>
      )}
      {groups.map((g) => {
        const Icon = ICONS[g.type];
        return (
          <Command.Group key={g.type} heading={g.label} forceMount className={groupClass} data-testid={`search-group-${g.type}`}>
            {g.items.map((it) => (
              <Command.Item key={`${it.type}:${it.id}`} value={`content ${it.type} ${it.id}`} keywords={[search]} forceMount onSelect={() => onOpen(it.url, it.title)}
                data-testid="search-result" data-url={it.url}
                className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-2 text-[13.5px] text-muted data-[selected=true]:bg-hover data-[selected=true]:text-fg">
                <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-fg" title={it.title}>{it.title}</span>
                  {(it.subtitle || it.snippet) && <span className="block truncate text-xs text-subtle">{[it.subtitle, it.snippet].filter(Boolean).join("  ")}</span>}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        );
      })}
      {state.data?.partial && <div className="px-4 py-2 text-xs text-subtle">Some results took too long and are not shown. Try a longer word.</div>}
    </>
  );
}
