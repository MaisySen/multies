/**
 * R74: the editors keep the picked PDF through a reload of the tab (lib/kept-files.ts) and ask before it is lost
 * (components/tools/leave-guard.tsx). A PDF from an email is not copied: its address already brings it back.
 */
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { forgetFiles, keepFiles, keptFiles } from "@/web/lib/kept-files";
import type { Source } from "./runner";

export const RESTORED_LINE = "Your file is back after the reload.";

/**
 * Restores a kept PDF on first open (only when nothing else was picked) and keeps the current one from then on.
 * `done` forgets it: the result is saved, nothing is left to lose.
 */
export function useKeptSource(key: string, src: Source | null, setSrc: (s: Source) => void, done: boolean): void {
  const ready = useRef(false);
  const first = useRef(src);
  useEffect(() => {
    let live = true;
    if (first.current) { ready.current = true; return; }
    void keptFiles(key).then((files) => {
      ready.current = true;
      if (!live || !files?.[0]) return;
      setSrc({ kind: "file", file: files[0] });
      toast(RESTORED_LINE);
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    if (!ready.current && !src) return; // the restore above is still reading; do not delete under it
    if (!src || done || src.kind !== "file") void forgetFiles(key);
    else void keepFiles(key, [src.file]);
  }, [key, src, done]);
}
