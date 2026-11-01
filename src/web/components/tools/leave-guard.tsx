/**
 * R74: leaving a Tools screen with a picked file that has not been run or saved asks first.
 *  - Reload, close or typing another address: the browser's own "Leave site?" question (beforeunload).
 *  - A link inside Multies: our own small dialog, Stay or Leave. Moving to another tool that takes the file over
 *    (the file is handed on) never asks.
 * Use: const guard = useLeaveGuard(dirty); ... {guard}
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useBlocker, useLocation, useNavigate, type Location } from "react-router";
import { Dialog } from "@/web/components/ui/dialog";
import { Button } from "@/web/components/ui/button";
import { peekCarried } from "@/web/lib/carried-files";

/** Whether an in app move from here should ask: a new page, and the file is not being handed to it. */
export function shouldAsk(dirty: boolean, from: { pathname: string }, to: { pathname: string }, handedOn: number): boolean {
  return dirty && from.pathname !== to.pathname && handedOn === 0;
}

/** F12 (MB-296): `description` replaces the default line, for screens with unsaved edits rather than a picked file. */
export function useLeaveGuard(dirty: boolean, what = "your file", description?: string) {
  useEffect(() => {
    if (!dirty) return;
    const onBefore = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", onBefore);
    return () => window.removeEventListener("beforeunload", onBefore);
  }, [dirty]);
  // F12 (MB-296): Back is held by the router and the page put back; the router can drop its "blocked" state while it
  // puts the page back, so the question keeps its own open state and remembers where the move was going.
  const skip = useRef(false);
  const here = useRef(useLocation().pathname);
  const attempt = useRef<{ to: string; pop: boolean } | null>(null);
  const ask = useCallback(({ currentLocation, nextLocation, historyAction }: { currentLocation: Location; nextLocation: Location; historyAction: string }) => {
    // A move back to this page (the router putting the page back after a held Back) never asks.
    if (skip.current || nextLocation.pathname === here.current || !shouldAsk(dirty, currentLocation, nextLocation, peekCarried().length)) return false;
    attempt.current = { to: nextLocation.pathname + nextLocation.search + nextLocation.hash, pop: historyAction === "POP" };
    return true;
  }, [dirty]);
  const blocker = useBlocker(ask);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  useEffect(() => { if (blocker.state === "blocked") setOpen(true); }, [blocker.state]);
  useEffect(() => { if (!dirty) setOpen(false); }, [dirty]);
  const stay = () => { if (blocker.state === "blocked") blocker.reset?.(); setOpen(false); };
  const leave = () => {
    setOpen(false);
    if (blocker.state === "blocked") { blocker.proceed?.(); return; }
    const a = attempt.current;
    if (!a) return;
    skip.current = true;
    if (a.pop) void navigate(-1); else void navigate(a.to);
  };
  return (
    <Dialog open={open} onClose={stay} title="Leave this page?"
      description={description ?? `You have not run or saved ${what} yet. If you leave, you will need to pick it again.`}
      footer={<>
        <Button type="button" variant="ghost" onClick={stay} data-testid="leave-stay" className="max-sm:min-h-11">Stay</Button>
        <Button type="button" onClick={leave} data-testid="leave-go" className="max-sm:min-h-11">Leave</Button>
      </>} />
  );
}
