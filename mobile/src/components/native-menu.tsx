import type { ReactNode } from "react";
import { Platform } from "react-native";
import { nativeContextMenu } from "@/lib/native-modules";
import { sfSymbolFor } from "./sf-symbols";
import type { IconName } from "./icons";

export interface NativeMenuItem { id: string; title: string; icon?: IconName; destructive?: boolean }

/** R37: whether rows get the native iOS context menu (1.10.0 builds); otherwise the hold sheet stays. */
export function hasNativeMenu(): boolean {
  return Platform.OS === "ios" && !!nativeContextMenu();
}

/**
 * R37 (store build 1.10.0): a long-press on a row lifts it and shows the native iOS context menu
 * with the same actions as the hold sheet. Where the native module is missing (older binaries,
 * Android, web, tests) it renders the row as it was, and the row's own long-press opens the sheet.
 */
export function NativeContextMenu({ items, onSelect, children, title }: { items: NativeMenuItem[]; onSelect: (id: string) => void; children: ReactNode; title?: string }) {
  const M = Platform.OS === "ios" ? nativeContextMenu() : null;
  if (!M) return <>{children}</>;
  return (
    <M.Root>
      <M.Trigger>{children}</M.Trigger>
      <M.Content>
        {title ? <M.Label>{title}</M.Label> : null}
        {items.map((it) => {
          const symbol = it.icon ? sfSymbolFor(it.icon) : null;
          return (
            <M.Item key={it.id} onSelect={() => onSelect(it.id)} destructive={it.destructive}>
              <M.ItemTitle>{it.title}</M.ItemTitle>
              {symbol ? <M.ItemIcon ios={{ name: symbol as never }} /> : null}
            </M.Item>
          );
        })}
      </M.Content>
    </M.Root>
  );
}
