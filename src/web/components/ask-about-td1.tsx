/**
 * TD1 "Ask about this": opens Ask scoped to one item (task, doc, table, deal, meeting). Shown only while Ask and ASK_TD1
 * are on. The server checks the asker can open the item; the title in the link is only for showing.
 */
import { Link } from "react-router";
import { IconSparkle } from "@/web/components/ui/icon";
import { useConfig } from "@/web/lib/queries";
import type { AboutKind } from "@/shared/ask-td1";

const focus = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

/** Whether "Ask about this" shows (Ask and ASK_TD1 both on). */
export function useAskAboutOn(): boolean {
  const config = useConfig();
  return !!(config.data?.askR110 && config.data?.askTd1);
}

export function askAboutHref(kind: AboutKind, id: string, title?: string): string {
  const p = new URLSearchParams({ about: `${kind}:${id}` });
  if (title) p.set("title", title.slice(0, 120));
  return `/app/tools/ask?${p.toString()}`;
}

/** `wrap`: classes for a wrapping div, rendered only when the button shows (so flag off leaves the layout exactly as today). */
export function AskAboutButton({ kind, id, title, compact = false, wrap }: { kind: AboutKind; id: string; title?: string; compact?: boolean; wrap?: string }) {
  const config = useConfig();
  if (!config.data?.askR110 || !config.data?.askTd1 || !id) return null;
  const link = (
    <Link to={askAboutHref(kind, id, title)} data-testid="ask-about-this"
      className={compact
        ? `inline-flex h-11 w-11 items-center justify-center rounded-full text-muted transition-colors duration-150 hover:bg-elevated hover:text-fg sm:h-auto sm:w-auto sm:rounded-md sm:p-1.5 ${focus}`
        : `inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[13px] font-medium text-fg transition-colors duration-150 hover:bg-hover max-sm:min-h-11 ${focus}`}
      aria-label={compact ? "Ask about this" : undefined} title="Ask a question about this item">
      <IconSparkle className={compact ? "h-4 w-4" : "h-4 w-4 text-muted"} aria-hidden />
      {!compact && <span>Ask about this</span>}
    </Link>
  );
  return wrap ? <div className={wrap}>{link}</div> : link;
}
