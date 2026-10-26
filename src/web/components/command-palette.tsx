/**
 * Cmd+K / Ctrl+K: jump anywhere, run common actions. R31: everything comes from the one command
 * registry (lib/commands); with a task focused its actions lead, and its pickers open as nested pages
 * (Backspace on an empty search goes back). Loaded on demand by PaletteHost (palette-host.tsx).
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Command } from "cmdk";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ChevronLeft, Globe, Inbox, LogOut, Search, Sun } from "lucide-react";
import { paletteScore } from "@/web/lib/palette-registry";
import { openShortcutsSheet } from "@/web/lib/shortcuts";
import { COMMANDS, TASK_PICKERS, inPalette, runCommand, useFocus, type Command as Cmd, type CommandContext, type TaskPickerPage } from "@/web/lib/commands";
import { taskPickerItems, type PickerItem } from "@/web/lib/commands/task-pickers";
import { useAppearance } from "@/web/components/theme";
import { ContentGroups, useContentSearch } from "@/web/components/search-results";
import { useDomains, useMailboxes } from "@/web/lib/queries";
import { useAssignees, useProjects, useTaskDetail, useTaskMutations, type Task } from "@/web/pages/app/work/data";
import { Kbd } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";

type Item = { id: string; label: string; hint?: string; icon: React.ComponentType<{ className?: string }>; run: () => void; keywords?: string[]; current?: boolean; keys?: string[] };

const groupClass = "px-1.5 pb-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-subtle";

/** The focused task, from any task list already loaded, else its detail. */
function useFocusedTask(id: string | null): Task | null {
  const qc = useQueryClient();
  const detail = useTaskDetail(id);
  return useMemo(() => {
    if (!id) return null;
    for (const [, list] of qc.getQueriesData<Task[]>({ queryKey: ["tasks"] })) {
      const t = Array.isArray(list) ? list.find((x) => x.id === id) : undefined;
      if (t) return t;
    }
    return detail.data?.task ?? null;
  }, [id, qc, detail.data]);
}

export default function CommandPalette({ open, onOpenChange, onSignOut, page, onPage }: {
  open: boolean; onOpenChange: (v: boolean) => void; onSignOut: () => void; page: string | null; onPage: (p: string | null) => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const domains = useDomains();
  const mailboxes = useMailboxes();
  const focus = useFocus();
  const [search, setSearch] = useState("");
  const appearance = useAppearance();
  const close = () => { onOpenChange(false); setSearch(""); };
  const ctx: CommandContext = {
    navigate: (to) => { close(); navigate(to); },
    openSheet: () => { close(); openShortcutsSheet(); },
    openPalette: (p) => { setSearch(""); onPage(p ?? null); },
    toggleTheme: () => { close(); appearance.set(appearance.resolved === "dark" ? "light" : "dark"); },
  };

  // Round 20: content from mail, tasks, docs, chat, contacts and deals, searched on the server.
  const content = useContentSearch(search, open && !page);
  const taskId = focus.kind === "task" ? focus.id : null;
  const task = useFocusedTask(open ? taskId : null);
  const projects = useProjects();
  const people = useAssignees();
  const { update } = useTaskMutations();

  const toItem = (c: Cmd): Item => ({
    id: c.id, label: c.title, icon: c.id === "action-theme" && appearance.resolved === "dark" ? Sun : c.icon ?? Search, keywords: c.keywords,
    keys: c.scope !== "global" ? c.keys : undefined,
    run: () => {
      // Page commands (mail keys) run after the menu closes, so they act on the page, not the menu.
      if (c.handler === "page") { close(); setTimeout(() => { if (!runCommand(c, ctx)) toast.info("Open a message first"); }, 0); return; }
      runCommand(c, ctx);
    },
  });
  const palette = COMMANDS.filter(inPalette);
  const contextual = palette.filter((c) => c.when && c.when({ focus }) && (c.scope !== "task" || !!task));
  const actions = palette.filter((c) => !c.when && c.group !== "Go to").map(toItem);
  const pages = palette.filter((c) => !c.when && c.group === "Go to").map(toItem);
  const go = (to: string) => () => ctx.navigate(to);
  const records: Item[] = [
    ...(domains.data ?? []).map((d) => ({ id: `d-${d.id}`, label: d.name, hint: "Domain", icon: Globe, run: go(`/app/domains/${d.id}`) })),
    ...(mailboxes.data ?? []).map((m) => ({ id: `m-${m.id}`, label: m.address, hint: "Mailbox", icon: Inbox, run: go(`/app/mail?mailbox=${m.id}`) })),
  ];

  // Nested picker pages for the focused task.
  const pickerPage = page?.startsWith("task:") ? (page.slice(5) as TaskPickerPage) : null;
  const picker = pickerPage ? TASK_PICKERS.find((p) => p.page === pickerPage) : undefined;
  const labels = useMemo(() => {
    const all = new Set<string>();
    for (const [, list] of qc.getQueriesData<Task[]>({ queryKey: ["tasks"] })) if (Array.isArray(list)) for (const t of list) for (const l of t.labels) all.add(l);
    return [...all];
  }, [qc, pickerPage]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (it: PickerItem) => {
    if (!task) return;
    close();
    // Optimistic: every loaded list shows the change now; a refusal puts the lists back.
    const before = qc.getQueriesData<Task[]>({ queryKey: ["tasks"] });
    for (const [key, list] of before) if (Array.isArray(list)) qc.setQueryData<Task[]>(key, list.map((t) => (t.id === task.id ? { ...t, ...it.view } : t)));
    update.mutate({ id: task.id, patch: it.patch }, {
      onSuccess: () => toast.success(it.done),
      onError: () => { for (const [key, list] of before) qc.setQueryData(key, list); },
    });
  };
  const pickerItems: Item[] = picker && task
    ? taskPickerItems(picker.page, task, { projects: projects.data ?? [], people: people.data ?? [], labels, search }).map((it) => ({
      id: it.id, label: it.label, hint: it.hint, icon: picker.icon ?? Check, current: it.current, run: () => pick(it), keywords: [it.label],
    }))
    : [];

  const group = (heading: string, items: Item[], testId?: string) => items.length > 0 && (
    <Command.Group heading={heading} className={groupClass} data-testid={testId}>
      {items.map(({ id, label, hint, icon: Icon, run, keywords, current, keys }) => (
        <Command.Item key={id} value={`${label}|${id}`} keywords={keywords} onSelect={run}
          className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-[13.5px] text-muted transition-colors duration-150 data-[selected=true]:bg-hover data-[selected=true]:text-fg motion-reduce:transition-none">
          <Icon className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {hint && <span className="text-xs text-subtle">{hint}</span>}
          {current && <Check className="h-4 w-4 shrink-0 text-brand" aria-label="Current" />}
          {keys && <span className="flex gap-1">{keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</span>}
        </Command.Item>
      ))}
    </Command.Group>
  );

  const taskTitle = task ? `${task.ref} ${task.title}` : "";
  return (
    <Command.Dialog open={open} onOpenChange={(v) => { if (!v) close(); else onOpenChange(v); }} label="Command menu" filter={paletteScore}
      onKeyDown={(e) => { if (e.key === "Backspace" && !search && page) { e.preventDefault(); onPage(null); } }}
      overlayClassName="fixed inset-0 z-[90] bg-black/40 backdrop-blur-[2px] animate-fade-in motion-reduce:animate-none"
      contentClassName="fixed left-1/2 top-[12vh] z-[100] w-[min(640px,calc(100vw-24px))] -translate-x-1/2 overflow-hidden rounded-xl border border-line-strong bg-surface shadow-pop animate-pop-in motion-reduce:animate-none max-sm:top-[max(12px,env(safe-area-inset-top))] max-sm:rounded-2xl">
      {picker && (
        <div className="flex items-center gap-1.5 border-b border-line px-3.5 pt-2.5 pb-2 text-[12px] text-subtle">
          <button type="button" onClick={() => onPage(null)} aria-label="Back" className="grid h-6 w-6 place-items-center rounded hover:bg-hover max-sm:h-9 max-sm:w-9 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#0071E3]"><ChevronLeft className="h-3.5 w-3.5" /></button>
          <span className="min-w-0 truncate" data-testid="palette-crumb">{taskTitle}</span>
        </div>
      )}
      <div className="flex items-center gap-2.5 border-b border-line px-3.5">
        <Search className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
        <Command.Input value={search} onValueChange={setSearch}
          placeholder={picker ? picker.title.replace("...", "") : "Search mail, tasks, docs and chat, or jump to a page"}
          className="h-12 w-full bg-transparent text-[14px] text-fg outline-none placeholder:text-subtle" />
        <Kbd>Esc</Kbd>
      </div>
      <Command.List className={cn("max-h-[min(420px,60vh)] overflow-y-auto overscroll-contain py-1")}>
        {picker ? (
          <>
            {!task && <div className="px-4 py-8 text-center text-sm text-muted">Loading the task</div>}
            <Command.Empty className="px-4 py-8 text-center text-sm text-muted">Nothing matches “{search}”.</Command.Empty>
            {group(picker.title.replace("...", ""), pickerItems, "palette-picker")}
          </>
        ) : (
          <>
            {!content.loading && !content.data?.groups.length && <Command.Empty className="px-4 py-8 text-center text-sm text-muted">Nothing matches “{search}”.</Command.Empty>}
            {group(task && focus.kind === "task" ? `Task ${task.ref}` : "This message", contextual.map(toItem), "palette-context")}
            <ContentGroups state={content} search={search} onOpen={(url) => { close(); navigate(url); }} />
            {group("Actions", actions)}
            {group("Go to", pages)}
            {group("Domains and mailboxes", records)}
            {group("Account", [{ id: "signout", label: "Sign out", icon: LogOut, run: () => { close(); onSignOut(); } }])}
          </>
        )}
      </Command.List>
    </Command.Dialog>
  );
}
