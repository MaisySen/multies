/**
 * R36: end to end recipes on the MCP tools docs page (/developers/mcp). Each step names a real tool;
 * tests/mcp-catalog-r36.test.ts fails if a tool here is renamed or removed.
 */
export interface McpRecipe { id: string; title: string; summary: string; prompt: string; scopes: string[]; steps: { tool: string; why: string; arguments: Record<string, unknown> }[] }

export const MCP_RECIPES: McpRecipe[] = [
  {
    id: "triage-inbox", title: "Triage my inbox", summary: "Read what is unread, reply to the easy ones, turn the rest into tasks and snooze what can wait.",
    prompt: "Go through my unread mail. Reply to simple questions, make a task for anything that needs work, and snooze newsletters until Monday.",
    scopes: ["mail:send", "tasks:write"],
    steps: [
      { tool: "list_threads", why: "Find unread threads, newest first.", arguments: { unread: true, limit: 20 } },
      { tool: "read_thread", why: "Read one thread in full.", arguments: { threadId: "thr_8d7c6b5a" } },
      { tool: "reply", why: "Answer it as an agent inbox (may wait for approval).", arguments: { threadId: "thr_8d7c6b5a", text: "Thanks Ada, the invoice is paid." } },
      { tool: "snooze_thread", why: "Hide what can wait until a set time.", arguments: { threadId: "thr_8d7c6b5b", at: "2026-11-02T09:00:00.000Z" } },
    ],
  },
  {
    id: "email-to-task", title: "Turn an email into a task", summary: "Make a task from a thread, with the email linked, then tell the sender it is in hand.",
    prompt: "Make a task from the email about the broken login, give it to Sam for Friday, and reply that we are on it.",
    scopes: ["mail:send", "tasks:write"],
    steps: [
      { tool: "search", why: "Find the thread.", arguments: { query: "login broken" } },
      { tool: "create_task", why: "Create the task with the thread linked.", arguments: { title: "Login page shows a blank screen on Safari", threadId: "thr_8d7c6b5a", due: "2026-11-06" } },
      { tool: "reply", why: "Let the sender know.", arguments: { threadId: "thr_8d7c6b5a", text: "Thanks, we are on it. Tracking it as OPS-14." } },
    ],
  },
  {
    id: "daily-standup", title: "Post a daily standup", summary: "Collect what moved since yesterday and post a short summary to a chat channel.",
    prompt: "Every morning, post a standup to #team: what got done yesterday, what is in progress and what is blocked.",
    scopes: ["tasks:read", "chat:write"],
    steps: [
      { tool: "search_tasks", why: "Find tasks done since yesterday and those in progress.", arguments: { q: "status:done updated:>yesterday" } },
      { tool: "list_channels", why: "Find the team channel id.", arguments: {} },
      { tool: "post_message", why: "Post the summary.", arguments: { channelId: "chn_8d7c6b5a", body: "Standup: 3 done, 2 in progress, nothing blocked." } },
    ],
  },
  {
    id: "bug-from-chat", title: "File a bug from chat", summary: "Turn a chat message into a task in the right project, then answer in the thread.",
    prompt: "Make a bug from Ana's message in #support and answer her in the thread with the task link.",
    scopes: ["chat:write", "tasks:write"],
    steps: [
      { tool: "read_channel", why: "Find the message.", arguments: { channelId: "chn_8d7c6b5a" } },
      { tool: "message_to_task", why: "Create the task from the message (linked back to it).", arguments: { messageId: "chm_8d7c6b5a" } },
      { tool: "post_message", why: "Reply in the thread with the task.", arguments: { channelId: "chn_8d7c6b5a", parentId: "chm_8d7c6b5a", body: "Filed as OPS-15." } },
    ],
  },
  {
    id: "pick-up-work", title: "Work through my assigned tasks", summary: "An agent takes the next task, records what it did, and marks it done.",
    prompt: "Take my next task, do it, leave a comment with what you did and mark it done.",
    scopes: ["tasks:write"],
    steps: [
      { tool: "next_task", why: "Claim the next task assigned to this key.", arguments: {} },
      { tool: "comment_on_task", why: "Record what was done.", arguments: { id: "OPS-12", body: "Sent the reminder and updated the invoice." } },
      { tool: "update_task", why: "Mark it done.", arguments: { id: "OPS-12", status: "done" } },
    ],
  },
];
