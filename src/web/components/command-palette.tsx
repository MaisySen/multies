import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Command } from "cmdk";
import { Activity, BookOpen, CreditCard, Globe, Inbox, KeyRound, LayoutDashboard, LogOut, PenSquare, Plus, Search, Settings, ShieldCheck, Smartphone, UserPlus, Users } from "lucide-react";
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
  const actions: Item[] = [
    { id: "compose", label: "Write an email", icon: PenSquare, run: go("/app/mail?compose=1"), keywords: ["compose", "new message", "send"] },
    { id: "add-domain", label: "Add a domain", icon: Plus, run: go("/app/domains?add=1") },
    { id: "add-mailbox", label: "Create a mailbox", icon: Plus, run: go("/app/mailboxes?add=1") },
    { id: "invite", label: "Invite a teammate", icon: UserPlus, run: go("/app/settings/team"), keywords: ["member", "team"] },
    { id: "api-key", label: "Create an API key", icon: KeyRound, run: go("/app/settings/developers"), keywords: ["developer", "token"] },
    { id: "app-password", label: "Set up Outlook or Apple Mail", icon: Smartphone, run: go("/app/settings/mail-apps"), keywords: ["imap", "smtp", "app password", "thunderbird", "phone"] },
  ];
  const pages: Item[] = [
    { id: "p-overview", label: "Overview", icon: LayoutDashboard, run: go("/app") },
    { id: "p-mail", label: "Mail", icon: Inbox, run: go("/app/mail"), keywords: ["inbox", "webmail"] },
    { id: "p-domains", label: "Domains", icon: Globe, run: go("/app/domains"), keywords: ["dns"] },
    { id: "p-mailboxes", label: "Mailboxes and aliases", icon: Users, run: go("/app/mailboxes") },
    { id: "p-deliverability", label: "Deliverability", icon: ShieldCheck, run: go("/app/deliverability"), keywords: ["dmarc", "bounces", "suppression", "health"] },
    { id: "p-activity", label: "Activity", icon: Activity, run: go("/app/activity"), keywords: ["log", "audit"] },
    { id: "p-settings", label: "Settings", icon: Settings, run: go("/app/settings") },
    { id: "p-billing", label: "Billing", icon: CreditCard, run: go("/app/settings/billing"), keywords: ["plan", "upgrade", "invoice"] },
    { id: "p-docs", label: "API reference", icon: BookOpen, run: () => { onOpenChange(false); window.open("/api/v1/docs", "_blank", "noopener"); } },
  ];
  const records: Item[] = [
    ...(domains.data ?? []).map((d) => ({ id: `d-${d.id}`, label: d.name, hint: "Domain", icon: Globe, run: go(`/app/domains/${d.id}`) })),
    ...(mailboxes.data ?? []).map((m) => ({ id: `m-${m.id}`, label: m.address, hint: "Mailbox", icon: Inbox, run: go(`/app/mail?mailbox=${m.id}`) })),
  ];

  const group = (heading: string, items: Item[]) => items.length > 0 && (
    <Command.Group heading={heading} className="px-1.5 pb-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-subtle">
      {items.map(({ id, label, hint, icon: Icon, run, keywords }) => (
        <Command.Item key={id} value={`${label} ${id}`} keywords={keywords} onSelect={run}
          className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-[13.5px] text-muted data-[selected=true]:bg-hover data-[selected=true]:text-fg">
          <Icon className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {hint && <span className="text-xs text-subtle">{hint}</span>}
        </Command.Item>
      ))}
    </Command.Group>
  );

  return (
    <Command.Dialog open={open} onOpenChange={onOpenChange} label="Command menu"
      overlayClassName="fixed inset-0 z-[90] bg-black/60 animate-fade-in"
      contentClassName="fixed left-1/2 top-[12vh] z-[100] w-[min(640px,calc(100vw-24px))] -translate-x-1/2 overflow-hidden rounded-xl border border-line-strong bg-surface shadow-pop animate-pop-in">
      <div className="flex items-center gap-2.5 border-b border-line px-3.5">
        <Search className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
        <Command.Input value={search} onValueChange={setSearch} placeholder="Jump to a page, domain or mailbox, or run an action" className="h-12 w-full bg-transparent text-[14px] text-fg outline-none placeholder:text-subtle" />
        <Kbd>Esc</Kbd>
      </div>
      <Command.List className={cn("max-h-[min(420px,60vh)] overflow-y-auto overscroll-contain py-1")}>
        <Command.Empty className="px-4 py-8 text-center text-sm text-muted">Nothing matches “{search}”.</Command.Empty>
        {group("Actions", actions)}
        {group("Go to", pages)}
        {group("Domains and mailboxes", records)}
        {group("Account", [{ id: "signout", label: "Sign out", icon: LogOut, run: () => { onOpenChange(false); onSignOut(); } }])}
      </Command.List>
    </Command.Dialog>
  );
}
