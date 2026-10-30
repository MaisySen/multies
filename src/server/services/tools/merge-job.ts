/** Tools P2 (mail merge): the queued send of one person's email. Imported by the automation routes so it registers with the app. */
import { registerJob } from "../jobs";
import { sendMergeOne } from "./automation";

registerJob("tools.merge_send", async (deps, payload) => { await sendMergeOne(deps, payload as { runId: string; orgId: string; idx: number }); });
