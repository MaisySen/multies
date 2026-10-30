/**
 * R74: leaving a Tools screen with a picked file that has not been run or saved asks first.
 *  - Reload, close or typing another address: the browser's own "Leave site?" question (beforeunload).
 *  - A link inside Multies: our own small dialog, Stay or Leave. Moving to another tool that takes the file over
 *    (the file is handed on) never asks.
 * Use: const guard = useLeaveGuard(dirty); ... {guard}
 */
import { useEffect } from "react";
import { useBlocker } from "react-router";
import { Dialog } from "@/web/components/ui/dialog";
import { Button } from "@/web/components/ui/button";
import { peekCarried } from "@/web/lib/carried-files";

/** Whether an in app move from here should ask: a new page, and the file is not being handed to it. */
export function shouldAsk(dirty: boolean, from: { pathname: string }, to: { pathname: string }, handedOn: number): boolean {
  return dirty && from.pathname !== to.pathname && handedOn === 0;
}

export function useLeaveGuard(dirty: boolean, what = "your file") {
  useEffect(() => {
    if (!dirty) return;
    const onBefore = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", onBefore);
    return () => window.removeEventListener("beforeunload", onBefore);
  }, [dirty]);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => shouldAsk(dirty, currentLocation, nextLocation, peekCarried().length));
  const open = blocker.state === "blocked";
  return (
    <Dialog open={open} onClose={() => blocker.reset?.()} title="Leave this page?"
      description={`You have not run or saved ${what} yet. If you leave, you will need to pick it again.`}
      footer={<>
        <Button type="button" variant="ghost" onClick={() => blocker.reset?.()} data-testid="leave-stay" className="max-sm:min-h-11">Stay</Button>
        <Button type="button" onClick={() => blocker.proceed?.()} data-testid="leave-go" className="max-sm:min-h-11">Leave</Button>
      </>} />
  );
}
