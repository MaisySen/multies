/**
 * OPS1: tabs for a console detail page, one address per tab (/console/workspaces/:id/:tab?).
 * Usage:
 *   const tabs = [{ id: "overview", label: "Overview" }, { id: "billing", label: "Billing", permission: "billing.read" }];
 *   const tab = useDetailTab(tabs);                      // the current tab id (first tab when the address has none)
 *   <DetailTabs tabs={tabs} base={`/console/workspaces/${id}`} />
 *   {tab === "billing" && <BillingTab id={id} />}
 * Tabs whose permission the role lacks are hidden; an address naming one falls back to the first tab.
 */
import { NavLink, useParams } from "react-router";
import { cn } from "@/web/lib/cn";
import type { Permission } from "@/shared/operator-permissions";
import { useConsoleMe } from "../guard";

export interface DetailTab { id: string; label: string; permission?: Permission }

function visible(tabs: DetailTab[], permissions: readonly Permission[]) {
  return tabs.filter((t) => !t.permission || permissions.includes(t.permission));
}

export function useDetailTab(tabs: DetailTab[]): string {
  const { tab } = useParams();
  const me = useConsoleMe();
  const shown = visible(tabs, me.permissions);
  return shown.find((t) => t.id === tab)?.id ?? shown[0]?.id ?? "";
}

export function DetailTabs({ tabs, base }: { tabs: DetailTab[]; base: string }) {
  const me = useConsoleMe();
  const current = useDetailTab(tabs);
  const shown = visible(tabs, me.permissions);
  return (
    <nav aria-label="Sections" className="mb-5 overflow-x-auto border-b border-line">
      <ul className="flex min-w-max gap-1">
        {shown.map((t, i) => (
          <li key={t.id}>
            <NavLink to={i === 0 ? base : `${base}/${t.id}`} replace aria-current={current === t.id ? "page" : undefined}
              className={cn("-mb-px inline-flex h-10 items-center border-b-2 px-3 text-sm font-medium transition-colors", current === t.id ? "border-brand text-fg" : "border-transparent text-muted hover:text-fg")}>
              {t.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
