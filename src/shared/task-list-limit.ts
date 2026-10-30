/**
 * R45b: how many tasks one list read returns (GET /tasks without a limit, and the sprint backlog). Board, list and backlog
 * windowing can draw any number of rows, but the server sends at most this many per read, so a project past it shows
 * a plain notice instead of quietly short counts. Paging and change based refresh are the follow up (R46).
 */
export const TASK_LIST_LIMIT = 500;

/** True when a list read came back exactly full, so there may be more tasks than the ones on screen. A longer list (a
 * paged read, R46) is complete and shows no notice. */
export const listIsCapped = (count: number, limit: number = TASK_LIST_LIMIT) => count === limit;
