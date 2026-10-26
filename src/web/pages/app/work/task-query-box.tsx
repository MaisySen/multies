/**
 * R26 (MB-86): the task query box in the tasks filter bar. Type a query like `assignee:me status:doing label:bug`,
 * get key and value suggestions (statuses, labels, people, sprints) and a plain message with the character position
 * when something is off. The parser is the server's own (src/shared/task-query.ts). Enter applies the query.
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/web/lib/cn";
import { parseTaskQuery, suggest, TaskQueryError, type QueryKey } from "@/shared/task-query";

export function TaskQueryBox({ value, onApply, values }: { value: string; onApply: (q: string | null) => void; values: Partial<Record<QueryKey, string[]>> }) {
  const [text, setText] = useState(value);
  const [cursor, setCursor] = useState(value.length);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [navigated, setNavigated] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  // After a pick, the caret goes right after the inserted text, applied in the same commit (typing on keeps its place).
  const pendingCursor = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pendingCursor.current === null || !ref.current) return;
    ref.current.focus();
    ref.current.setSelectionRange(pendingCursor.current, pendingCursor.current);
    pendingCursor.current = null;
  });
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) { setLastValue(value); setText(value); }

  const error = useMemo(() => { try { parseTaskQuery(text); return null; } catch (e) { return e instanceof TaskQueryError ? e : null; } }, [text]);
  const sug = useMemo(() => suggest(text, cursor, values), [text, cursor, values]);
  const items = open ? sug.items : [];

  const pick = (i: number) => {
    const it = items[i];
    if (!it) return;
    const before = text.slice(0, sug.replaceFrom);
    const after = text.slice(cursor).replace(/^\S*/, "");
    const next = `${before}${it.insert}${after}`;
    setText(next);
    const at = before.length + it.insert.length;
    setCursor(at);
    setActive(0);
    setNavigated(false);
    pendingCursor.current = at;
  };
  const apply = () => { if (error) return; setOpen(false); onApply(text.trim() || null); };

  return (
    <div className="relative">
      <div className={cn("flex h-8 w-72 items-center gap-1.5 rounded-lg border bg-elevated px-2 text-[13px] focus-within:border-brand", error && !items.length ? "border-bad" : "border-line")}>
        <Search className="h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden />
        <input ref={ref} aria-label="Search tasks" role="combobox" aria-expanded={items.length > 0} aria-controls="task-query-suggestions" aria-autocomplete="list"
          aria-invalid={!!error} aria-describedby={error ? "task-query-error" : undefined}
          placeholder="Search or filter: assignee:me status:doing" value={text} spellCheck={false}
          className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] outline-none placeholder:font-sans placeholder:text-subtle"
          onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 120)}
          onChange={(e) => { setText(e.target.value); setCursor(e.target.selectionStart ?? e.target.value.length); setOpen(true); setActive(0); setNavigated(false); }}
          onSelect={(e) => setCursor((e.target as HTMLInputElement).selectionStart ?? text.length)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && items.length) { e.preventDefault(); setNavigated(true); setActive((a) => (a + 1) % items.length); }
            else if (e.key === "ArrowUp" && items.length) { e.preventDefault(); setNavigated(true); setActive((a) => (a - 1 + items.length) % items.length); }
            else if (e.key === "Tab" && items.length) { e.preventDefault(); pick(active); }
            else if (e.key === "Enter") { e.preventDefault(); if (navigated && items.length) pick(active); else apply(); }
            else if (e.key === "Escape") { if (open) { e.stopPropagation(); setOpen(false); } }
          }} />
        {text && <button type="button" aria-label="Clear the query" onClick={() => { setText(""); onApply(null); }} className="text-subtle hover:text-fg"><X className="h-3 w-3" /></button>}
      </div>
      {error && !items.length && <p id="task-query-error" role="alert" className="absolute left-0 top-9 z-30 w-80 rounded-md border border-bad/30 bg-elevated px-2 py-1 text-[12px] text-bad shadow-pop">{error.message}</p>}
      {items.length > 0 && (
        <ul id="task-query-suggestions" role="listbox" aria-label="Suggestions" className="absolute left-0 top-9 z-30 max-h-72 w-80 overflow-auto rounded-lg border border-line bg-elevated py-1 shadow-pop">
          {items.map((it, i) => (
            <li key={it.insert} role="option" aria-selected={i === active} onMouseDown={(e) => { e.preventDefault(); pick(i); }} onMouseEnter={() => setActive(i)}
              className={cn("flex cursor-pointer items-baseline gap-2 px-2.5 py-1.5 text-[12.5px]", i === active && "bg-hover")}>
              <span className="font-mono text-fg">{it.label}</span>
              {it.hint && <span className="truncate text-[11.5px] text-subtle">{it.hint}</span>}
            </li>
          ))}
          <li className="border-t border-line px-2.5 pt-1.5 pb-1 text-[11px] text-subtle" aria-hidden>Tab picks, Enter searches. Minus excludes: -label:wontfix. Quotes keep words together.</li>
        </ul>
      )}
    </div>
  );
}
