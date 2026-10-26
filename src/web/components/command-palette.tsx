import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Command } from "cmdk";
import { Globe, Inbox, LogOut, Search, Sun } from "lucide-react";
import { PALETTE_ACTIONS, PALETTE_PAGES, paletteScore, type PaletteAction } from "@/web/lib/palette-registry";
import { openShortcutsSheet } from "@/web/lib/shortcuts";
import { useAppearance } from "@/web/components/theme";
import { ContentGroups, useContentSearch } from "@/web/components/search-results";
import { useDomains, useMailboxes } from "@/web/lib/queries";
import { Kbd } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";

type Item = { id: string; label: string; hint?: string; icon: React.ComponentType<{ className?: string }>; run: () => void; keywords?: string[] };

/** Cmd+K / Ctrl+K: jump anywhere, run common actions. */
export function CommandPalette({ open, onOpenChange, onSignOut }: { open: boolean; onOpenChange: (v: boolean) => void; onSignOut: () => void }) {
  const navigate = useNavigate();
  const domains = useDomains();
  const mailboxes = useMailboxes();
  const [search, setSearch] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onOpenChange(!open); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);
  useEffect(() => { if (!open) setSearch(""); }, [open]);

  const go = (to: string) => () => { onOpenChange(false); navigate(to); };
  const appearance = useAppearance();
  // Round 20: content from mail, tasks, docs, chat, contacts and deals, searched on the server.
  const content = useContentSearch(search, open);
  // R30: pages and actions come from one registry (lib/palette-registry.ts) so every app page is reachable.
  const runAction = (a: PaletteAction) => () => {
    onOpenChange(false);
    if (a.kind === "shortcuts") openShortcutsSheet();
    else if (a.kind === "theme") appearance.set(appearance.resolved === "dark" ? "light" : "dark");
    else if (a.kind === "external" && a.to) window.open(a.to, "_blank", "noopener");
    else if (a.to) navigate(a.to);
  };
  const actions: Item[] = PALETTE_ACTIONS.map((a) => ({ id: a.id, label: a.label, icon: a.kind === "theme" && appearance.resolved === "dark" ? Sun : a.icon, run: runAction(a), keywords: a.keywords }));
  const pages: Item[] = PALETTE_PAGES.map((p) => ({ id: p.id, label: p.label, icon: p.icon, run: go(p.to), keywords: p.keywords }));
  const records: Item[] = [
    ...(domains.data ?? []).map((d) => ({ id: `d-${d.id}`, label: d.name, hint: "Domain", icon: Globe, run: go(`/app/domains/${d.id}`) })),
    ...(mailboxes.data ?? []).map((m) => ({ id: `m-${m.id}`, label: m.address, hint: "Mailbox", icon: Inbox, run: go(`/app/mail?mailbox=${m.id}`) })),
  ];

  const group = (heading: string, items: Item[]) => items.length > 0 && (
    <Command.Group heading={heading} className="px-1.5 pb-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-subtle">
      {items.map(({ id, label, hint, icon: Icon, run, keywords }) => (
        <Command.Item key={id} value={`${label}|${id}`} keywords={keywords} onSelect={run}
          className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-[13.5px] text-muted data-[selected=true]:bg-hover data-[selected=true]:text-fg">
          <Icon className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {hint && <span className="text-xs text-subtle">{hint}</span>}
        </Command.Item>
      ))}
    </Command.Group>
  );

  return (
    <Command.Dialog open={open} onOpenChange={onOpenChange} label="Command menu" filter={paletteScore}
      overlayClassName="fixed inset-0 z-[90] bg-black/40 animate-fade-in"
      contentClassName="fixed left-1/2 top-[12vh] z-[100] w-[min(640px,calc(100vw-24px))] -translate-x-1/2 overflow-hidden rounded-xl border border-line-strong bg-surface shadow-pop animate-pop-in">
      <div className="flex items-center gap-2.5 border-b border-line px-3.5">
        <Search className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
        <Command.Input value={search} onValueChange={setSearch} placeholder="Search mail, tasks, docs and chat, or jump to a page" className="h-12 w-full bg-transparent text-[14px] text-fg outline-none placeholder:text-subtle" />
        <Kbd>Esc</Kbd>
      </div>
      <Command.List className={cn("max-h-[min(420px,60vh)] overflow-y-auto overscroll-contain py-1")}>
        {!content.loading && !content.data?.groups.length && <Command.Empty className="px-4 py-8 text-center text-sm text-muted">Nothing matches “{search}”.</Command.Empty>}
        <ContentGroups state={content} search={search} onOpen={(url) => { onOpenChange(false); navigate(url); }} />
        {group("Actions", actions)}
        {group("Go to", pages)}
        {group("Domains and mailboxes", records)}
        {group("Account", [{ id: "signout", label: "Sign out", icon: LogOut, run: () => { onOpenChange(false); onSignOut(); } }])}
      </Command.List>
    </Command.Dialog>
  );
}
