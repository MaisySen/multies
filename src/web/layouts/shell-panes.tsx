/**
 * R79: the desktop shell's resizable panes (sidebar, page, details panel). Loaded only at 1024 px and wider, so a
 * phone's first screen does not download the panel library (R40 first load budget).
 */
import type { ReactNode } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels"; // R79 (MIT): resizable shell panes
import { panelStorage } from "@/web/lib/layout-prefs";
import { setInspectorEl } from "@/web/lib/inspector";
import { tr } from "@/web/i18n";

export function ShellPanes({ layoutGen, sidebarHidden, inspectorOpen, sidebar, main }: {
  layoutGen: number; sidebarHidden: boolean; inspectorOpen: boolean; sidebar: ReactNode; main: ReactNode;
}) {
  const shellLayout = useDefaultLayout({ id: "shell", storage: panelStorage, panelIds: [...(sidebarHidden ? [] : ["shell-sidebar"]), "shell-main", ...(inspectorOpen ? ["shell-inspector"] : [])] });
  return (
    <Group key={layoutGen} id="shell" orientation="horizontal" className="min-w-0 flex-1" defaultLayout={shellLayout.defaultLayout} onLayoutChanged={shellLayout.onLayoutChanged}>
      {!sidebarHidden && <>
        <Panel id="shell-sidebar" defaultSize="248px" minSize="200px" maxSize="420px" className="glass-sidebar">{sidebar}</Panel>
        {/* R82F: named by title (still read out), so axe does not count the handle as page content outside a landmark. */}
        <Separator className="shell-separator" title={tr("shell.resize_sidebar")} />
      </>}
      <Panel id="shell-main" minSize="480px">{main}</Panel>
      {inspectorOpen && <>
        <Separator className="shell-separator" title={tr("shell.resize_details_panel")} />
        <Panel id="shell-inspector" defaultSize="420px" minSize="340px" maxSize="760px">
          <div ref={setInspectorEl} className="h-full min-w-0 overflow-hidden" />
        </Panel>
      </>}
    </Group>
  );
}
