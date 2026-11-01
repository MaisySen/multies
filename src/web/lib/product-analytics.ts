import { areaFromPath, browserOptedOut } from "@/shared/product-analytics";

/**
 * ANALYTICS-PH: which areas and tools people open, for the Fintex team (internal only).
 * No third party script, no cookies, nothing stored on the device: the path is sent to our own server, which keeps
 * only the area and tool names, hashes the ids and forwards the event. Off when the server flag is off or when the
 * browser sends Do Not Track or Global Privacy Control.
 */
type Queued = { name: "area_opened"; path: string };
type Sender = (body: string, keepalive: boolean) => Promise<unknown>;

const ENDPOINT = "/api/analytics/events";
const FLUSH_MS = 5000;
const MAX = 20;

const defaultSender: Sender = (body, keepalive) =>
  fetch(ENDPOINT, { method: "POST", credentials: "same-origin", keepalive, headers: { "content-type": "application/json" }, body });

export function createProductAnalytics(opts: { sender?: Sender; optedOut?: () => boolean } = {}) {
  const send = opts.sender ?? defaultSender;
  const optedOut = opts.optedOut ?? (() => typeof navigator !== "undefined" && browserOptedOut(navigator as Navigator & { globalPrivacyControl?: boolean }, typeof window !== "undefined" ? (window as unknown as { doNotTrack?: string }) : undefined));
  let queue: Queued[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = "";

  const flush = (keepalive = false) => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!queue.length) return;
    const body = JSON.stringify({ events: queue.slice(0, MAX) });
    queue = [];
    void send(body, keepalive).catch(() => undefined);
  };

  /** Records that an app page was opened. Only /app paths; the same area (and tool) twice in a row counts once. */
  const pageOpened = (path: string) => {
    if (optedOut()) return;
    const a = areaFromPath(path);
    if (!a) return;
    // Only the area and tool names leave the page; ids and the rest of the path never do.
    const key = a.tool ? `/app/${a.area}/${a.tool}` : `/app/${a.area}`;
    if (key === last) return;
    last = key;
    queue.push({ name: "area_opened", path: key });
    if (queue.length >= MAX) flush();
    else if (!timer) timer = setTimeout(() => flush(), FLUSH_MS);
  };

  return { pageOpened, flush, pending: () => queue.length };
}

/**
 * R111 (ANALYTICS-PH low): flush queued events with a keepalive request when the page is hidden or goes away.
 * visibilitychange alone misses some closes (Safari, a tab closed from another window), so pagehide flushes too.
 * Returns the unsubscribe.
 */
export function flushOnPageHide(
  pa: { flush: (keepalive?: boolean) => void },
  win: Pick<Window, "addEventListener" | "removeEventListener"> = window,
  doc: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState"> = document,
): () => void {
  const hidden = () => { if (doc.visibilityState === "hidden") pa.flush(true); };
  const gone = () => pa.flush(true);
  doc.addEventListener("visibilitychange", hidden);
  win.addEventListener("pagehide", gone);
  return () => { doc.removeEventListener("visibilitychange", hidden); win.removeEventListener("pagehide", gone); };
}
