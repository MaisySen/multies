/**
 * R76: the webhook events on the public developer hub (/developers), grouped for reading. A unit test keeps this
 * list equal to the server's WEBHOOK_EVENTS, so the page never shows an event the server lacks or misses one.
 */
export const WEBHOOK_EVENT_GROUPS: { label: string; events: string[] }[] = [
  { label: "Mail", events: ["message.received", "message.sent", "message.bounced", "message.complained", "domain.verified", "domain.failed", "incoming_hook.received"] },
  { label: "Agents and approvals", events: ["approval.requested", "approval.decided", "agent.created", "agent.deleted"] },
  { label: "Tasks and projects", events: ["task.created", "task.updated", "task.deleted", "task.commented", "project.created", "project.deleted", "time_entry.created", "time_entry.updated", "project.updated", "custom_field.created", "custom_field.updated", "custom_field.deleted", "task.file_added", "task.recurred", "template.used", "goal.created", "goal.updated", "goal.deleted", "triage.created", "triage.accepted", "triage.declined", "triage.merged", "comment.created", "comment.updated", "comment.deleted"] },
  { label: "Docs, forms and meetings", events: ["doc.created", "doc.updated", "doc.deleted", "form.submitted", "meeting.created", "meeting.updated", "meeting.deleted", "booking.created", "booking.cancelled"] },
  { label: "Contacts and deals", events: ["contact.created", "contact.updated", "deal.created", "deal.updated"] },
  { label: "Chat and guests", events: ["guest.invited", "guest.joined", "guest.revoked", "chat.channel.created", "chat.message.created", "chat.message.updated", "chat.message.deleted", "chat.mention"] },
];
