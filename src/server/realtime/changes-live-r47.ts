/**
 * R47 (MB-139): live task lists. After a write lands in the change feed, the workspace's live hub (the same
 * ChatHub socket chat uses) tells every open tab the feed's new position. The frame carries no data: a tab
 * whose list is behind that position reads the feed and the tasks it names through the normal, access checked
 * API (paged-tasks-r46.ts), so a nudge can never show anyone a task they cannot read.
 *
 * Cost on the Free plan: at most one hub request per workspace per write burst in this isolate. While a publish
 * for a workspace is in flight, later writes only raise the position to send; when it finishes, one more publish
 * carries the newest position. A slow or missing hub never fails or slows a write past PUBLISH_WAIT_MS; open
 * lists then pick the change up from their safety poll.
 */
import type { Deps } from "../context";

/** How long a write waits for the hub before moving on (the publish carries on without it). */
export const PUBLISH_WAIT_MS = 250;

interface OrgState { inFlight: boolean; sent: number; pending: number; /** a batch write whose position is not known (sent as cursor 0) */ unknown: boolean }
const orgs = new Map<string, OrgState>();

/** Test hook. */
export function resetLiveChanges() { orgs.clear(); }

async function publishLoop(deps: Deps, orgId: string, st: OrgState) {
  const bus = deps.chatLive;
  st.inFlight = true;
  try {
    while (bus && (st.pending > st.sent || st.unknown)) {
      const cursor = st.pending > st.sent ? st.pending : 0;
      st.unknown = false;
      try {
        await bus.publish(orgId, { all: true }, { t: "changes", cursor });
      } catch (err) {
        deps.reportError?.(err, { where: "changes.live.publish" });
        return; // the next write tries again; open lists fall back to their poll
      } finally {
        st.sent = Math.max(st.sent, cursor);
      }
    }
  } finally {
    st.inFlight = false;
    if (orgs.size > 1000) for (const [k, v] of orgs) if (!v.inFlight) orgs.delete(k);
  }
}

/**
 * Tells open tabs in the workspace the feed reached `seq`. A batch write that does not know its position passes 0
 * (tabs then read the feed from where they are). Never throws, never waits past PUBLISH_WAIT_MS.
 */
export async function notifyLiveChanges(deps: Deps, orgId: string, seq: number | undefined) {
  if (!deps.chatLive) return;
  let st = orgs.get(orgId);
  if (!st) { st = { inFlight: false, sent: 0, pending: 0, unknown: false }; orgs.set(orgId, st); }
  if (seq) st.pending = Math.max(st.pending, seq);
  else st.unknown = true;
  if (st.inFlight) return; // the running publish sends the newest position when it finishes
  const run = publishLoop(deps, orgId, st);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = new Promise<void>((resolve) => { timer = setTimeout(resolve, PUBLISH_WAIT_MS); });
  await Promise.race([run, wait]).finally(() => clearTimeout(timer));
}
