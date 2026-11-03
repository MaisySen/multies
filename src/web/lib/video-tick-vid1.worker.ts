/** VID1: a steady frame clock for the call video compositor; a hidden tab still gets these messages on time. */
const scope = self as unknown as { onmessage: ((e: MessageEvent<{ fps?: number; stop?: boolean }>) => void) | null; postMessage: (m: unknown) => void };
let timer: ReturnType<typeof setInterval> | null = null;
scope.onmessage = (e) => {
  if (timer) clearInterval(timer);
  timer = null;
  if (e.data?.stop) return;
  const fps = Math.min(60, Math.max(1, Number(e.data?.fps) || 30));
  timer = setInterval(() => scope.postMessage(0), Math.round(1000 / fps));
};
export {};
