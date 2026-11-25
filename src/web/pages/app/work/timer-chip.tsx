import { Suspense } from "react";
import { IconPause } from "@/web/components/ui/icon";
import { useConfig } from "@/web/lib/queries";
import { lazyPage } from "@/web/components/lazy-page";
import { clockText, useElapsed, useRunningTimer, useTimerActions } from "./time-core";

// R95: the idle check only matters while a timer runs, so it loads then.
const IdlePrompt = lazyPage(() => import("./time-plus-r95"), "IdlePrompt", { quiet: true });

/** The running timer, shown in the app header on every page. */
export function TimerChip() {
  const running = useRunningTimer();
  const { stop, refresh } = useTimerActions();
  const secs = useElapsed(running.data);
  const plus = !!useConfig().data?.tasksPlus;
  if (!running.data) return null;
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-brand/40 bg-brand/10 py-0.5 pl-2.5 pr-1 text-[12.5px]" data-testid="timer-chip">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" aria-hidden />
      <span className="max-w-[140px] truncate text-muted">{running.data.task?.ref}</span>
      <span className="font-mono tabular-nums">{clockText(secs)}</span>
      <button className="rounded-full p-1 text-muted hover:bg-elevated hover:text-fg" aria-label="Stop timer" onClick={() => stop.mutate()}><IconPause className="h-3.5 w-3.5" /></button>
      {plus && <Suspense fallback={null}><IdlePrompt entry={running.data} onDone={refresh} /></Suspense>}
    </div>
  );
}

