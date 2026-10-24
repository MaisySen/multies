import { encodeMentions, filterPeople, groupChannels, insertMention, latestChange, mentionQuery, mentionsMe, mergeMessages, plainText, segments } from "@/lib/chat";
import { notificationTarget, orderedCategories, sortNotifications } from "@/lib/notifications";
import { describePush, fallbackText, routeForPush, channelFor } from "@/lib/push-events";
import { endpoints } from "@/api/endpoints";
import { SampleTransport } from "@/sample/transport";
import type { AppNotification, ChatChannel, ChatMessage } from "@/api/types";

const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: "m1", channelId: "c1", parentId: null, author: { type: "member", id: "u2", name: "Josh Tran" }, body: "", mentions: [], links: [], attachments: [],
  replyCount: 0, lastReplyAt: null, editedAt: null, deleted: false, createdAt: "2026-10-24T01:00:00.000Z", updatedAt: "2026-10-24T01:00:00.000Z", ...over,
});

describe("chat markup", () => {
  it("draws mentions as @Name and links as their ref and title", () => {
    const m = msg({
      body: "<@member:usr_1> please check <#task:tsk_9> and <#thread:thr_2> <!channel>",
      mentions: [{ type: "member", id: "usr_1", name: "Mia Nguyen" }],
      links: [{ type: "task", id: "tsk_9", ref: "OPS-3", title: "Chase INV-1042" }, { type: "thread", id: "thr_2", ref: null, title: "Re: Invoice" }],
    });
    expect(plainText(m)).toBe("@Mia Nguyen please check OPS-3 Chase INV-1042 and Re: Invoice @channel");
    const s = segments(m, "member:usr_1");
    expect(s[0]).toMatchObject({ kind: "mention", text: "@Mia Nguyen", self: true });
    expect(s.filter((x) => x.kind === "link")).toHaveLength(2);
    expect(mentionsMe(m, "member:usr_1")).toBe(true);
    expect(mentionsMe(msg({ body: "<@member:usr_7>" }), "member:usr_1")).toBe(false);
  });

  it("copes with mention ids given with or without the type prefix, and unknown ones", () => {
    expect(plainText(msg({ body: "<@agent:agt_1> hi", mentions: [{ type: "agent", id: "agent:agt_1", name: "Invoice chaser" }] }))).toBe("@Invoice chaser hi");
    expect(plainText(msg({ body: "<@member:nobody> <#doc:d1>" }))).toBe("@someone a doc");
  });

  it("turns picked names into markup before sending, longest name first", () => {
    const people = [{ id: "member:u1", name: "Jo" }, { id: "member:u2", name: "Jo Tran" }, { id: "agent:a1", name: "Invoice chaser" }];
    expect(encodeMentions("@Jo Tran and @Jo, ask @Invoice chaser. @channel", people)).toBe("<@member:u2> and <@member:u1>, ask <@agent:a1>. <!channel>");
    expect(encodeMentions("email me@example.com", [])).toBe("email me@example.com");
  });

  it("finds the @ being typed and puts the picked name in its place", () => {
    expect(mentionQuery("hey @jo")).toBe("jo");
    expect(mentionQuery("@")).toBe("");
    expect(mentionQuery("me@example")).toBeNull();
    expect(insertMention("hey @jo", "Josh Tran")).toBe("hey @Josh Tran ");
    const people = [{ id: "member:u1", type: "member" as const, name: "Josh Tran", email: "josh@x.au" }, { id: "member:u2", type: "member" as const, name: "Priya Shah", email: "p@x.au" }];
    expect(filterPeople(people, "tr").map((p) => p.name)).toEqual(["Josh Tran"]);
    expect(filterPeople(people, "")).toHaveLength(2);
  });

  it("lists channels by name, then DMs newest first, without archived ones", () => {
    const ch = (over: Partial<ChatChannel>): ChatChannel => ({ id: "x", kind: "channel", name: "x", topic: null, private: false, projectId: null, guestAccess: false, archived: false, members: [], unread: 0, mentions: 0, lastMessageAt: null, lastMessage: null, createdAt: "2026-01-01T00:00:00Z", ...over });
    const g = groupChannels([ch({ id: "b", name: "markets" }), ch({ id: "a", name: "general" }), ch({ id: "z", name: "old", archived: true }),
      ch({ id: "d1", kind: "dm", lastMessageAt: "2026-10-01T00:00:00Z" }), ch({ id: "d2", kind: "dm", lastMessageAt: "2026-10-20T00:00:00Z" })]);
    expect(g.channels.map((c) => c.id)).toEqual(["a", "b"]);
    expect(g.dms.map((c) => c.id)).toEqual(["d2", "d1"]);
  });

  it("merges polled messages in time order and replaces changed ones", () => {
    const a = msg({ id: "a", createdAt: "2026-10-24T01:00:00Z", updatedAt: "2026-10-24T01:00:00Z" });
    const b = msg({ id: "b", createdAt: "2026-10-24T01:02:00Z", updatedAt: "2026-10-24T01:02:00Z" });
    const a2 = { ...a, replyCount: 3, updatedAt: "2026-10-24T01:05:00Z" };
    const merged = mergeMessages([a, b], [a2, msg({ id: "c", createdAt: "2026-10-24T01:04:00Z", updatedAt: "2026-10-24T01:04:00Z" })]);
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(merged[0].replyCount).toBe(3);
    expect(latestChange(merged)).toBe("2026-10-24T01:05:00Z");
    expect(latestChange([])).toBeNull();
  });
});

describe("sample chat", () => {
  const setup = () => { const t = new SampleTransport(); return { t, api: endpoints(t) }; };

  it("has two channels and a DM, with unread and mention counts", async () => {
    const { api } = setup();
    const { channels } = await api.chatChannels();
    expect(channels.filter((c) => c.kind === "channel").map((c) => c.name).sort()).toEqual(["general", "markets"]);
    const general = channels.find((c) => c.name === "general")!;
    expect(general).toMatchObject({ unread: 2, mentions: 2 });
    expect(channels.find((c) => c.kind === "dm")).toMatchObject({ name: "Josh Tran", unread: 1 });
    const unread = await api.chatUnread();
    expect(unread).toMatchObject({ total: 3, mentions: 2 });
    await api.readChannel(general.id);
    expect((await api.chatUnread()).total).toBe(1);
  });

  it("resolves mentions and a linked task, keeps a thread and makes a task from a message", async () => {
    const { api } = setup();
    const { messages } = await api.chatMessages("chn_general", { limit: 50 });
    const ask = messages.find((m) => m.replyCount > 0)!;
    expect(ask.mentions[0]).toMatchObject({ type: "member", name: "Mia Nguyen" });
    expect(ask.links[0]).toMatchObject({ type: "task", ref: expect.stringMatching(/^OPS-/) });
    expect(messages.some((m) => m.attachments.length)).toBe(true);
    const thread = await api.chatThread(ask.id);
    expect(thread.replies).toHaveLength(2);
    expect(thread.replies[1].author.type).toBe("agent");
    const { task } = await api.chatMessageToTask(ask.id);
    const detail = await api.task(task.id);
    expect(detail.task.notes).toContain("From #general, Priya Shah");
  });

  it("posts a message with a mention, polls it with since, and replies in a thread", async () => {
    const { api } = setup();
    const before = await api.chatMessages("chn_markets", { limit: 50 });
    const since = before.messages[before.messages.length - 1].createdAt;
    const { message } = await api.sendChat("chn_markets", { body: "<@member:usr_josh> grinder sorted" });
    expect(message.mentions).toEqual([{ type: "member", id: "usr_josh", name: "Josh Tran" }]);
    const polled = await api.chatMessages("chn_markets", { since });
    expect(polled.messages.map((m) => m.id)).toEqual([message.id]);
    await new Promise((r) => setTimeout(r, 5));
    await api.sendChat("chn_markets", { body: "thanks", parentId: message.id });
    const again = await api.chatMessages("chn_markets", { since: message.createdAt });
    // The parent comes back with its new reply count; the reply itself stays in the thread.
    expect(again.messages.find((m) => m.id === message.id)?.replyCount).toBe(1);
    expect((await api.chatMessage(message.id)).channel.name).toBe("markets");
    await expect(api.sendChat("chn_markets", { body: "  " })).rejects.toMatchObject({ status: 422 });
  });

  it("finds an existing DM or starts a new one", async () => {
    const { api } = setup();
    expect((await api.startDm(["usr_josh"])).channel.id).toBe("dm_josh");
    const made = await api.startDm(["usr_priya"]);
    expect(made.channel).toMatchObject({ kind: "dm", name: "Priya Shah" });
    expect((await api.chatPeople()).people.some((p) => p.name === "Mia Nguyen")).toBe(false);
  });
});

describe("sample notifications", () => {
  it("filters, counts, marks read by id, category and all, and saves settings", async () => {
    const api = endpoints(new SampleTransport());
    const all = await api.notifications();
    expect(all.unread).toBe(4);
    expect(all.counts.mention).toBe(2);
    const mentions = await api.notifications({ category: "mention" });
    expect(mentions.notifications.every((n) => n.category === "mention")).toBe(true);
    await api.readNotifications({ ids: [mentions.notifications[0].id] });
    expect((await api.notifications()).unread).toBe(3);
    await api.readNotifications({ category: "mention" });
    expect((await api.notifications()).counts.mention).toBeUndefined();
    await api.unreadNotification(mentions.notifications[0].id);
    expect((await api.notifications({ unread: true })).notifications).toHaveLength(3);
    await api.readNotifications();
    expect((await api.notifications()).unread).toBe(0);
    const s = await api.saveNotificationSettings({ comment: { push: true } });
    expect(s.settings.comment).toEqual({ inApp: true, push: true });
    expect((await api.notificationSettings()).settings.comment.push).toBe(true);
  });

  it("sorts unread first and knows where each one opens", () => {
    const n = (over: Partial<AppNotification>): AppNotification => ({ id: "n", type: "x", entityType: null, entityId: null, title: "t", read: false, createdAt: "2026-10-24T00:00:00Z", ...over });
    const sorted = sortNotifications([n({ id: "old-read", read: true, createdAt: "2026-10-24T05:00:00Z" }), n({ id: "a", createdAt: "2026-10-24T01:00:00Z" }), n({ id: "b", createdAt: "2026-10-24T02:00:00Z" })]);
    expect(sorted.map((x) => x.id)).toEqual(["b", "a", "old-read"]);
    const web = "https://example.au";
    expect(notificationTarget(n({ entityType: "task", entityId: "t1" }), web)).toEqual({ kind: "route", href: { pathname: "/task/[id]", params: { id: "t1" } } });
    expect(notificationTarget(n({ entityType: "chat_message", entityId: "m1" }), web)).toEqual({ kind: "route", href: { pathname: "/chat/message/[id]", params: { id: "m1" } } });
    expect(notificationTarget(n({ entityType: "approval", entityId: "apr_1" }), web)).toMatchObject({ href: { pathname: "/approval/[id]" } });
    expect(notificationTarget(n({ entityType: "message", entityId: "msg_1" }), web)).toMatchObject({ href: { pathname: "/thread/[id]" } });
    expect(notificationTarget(n({ entityType: "goal", entityId: "g1", link: "/app/goals/g1" }), web)).toEqual({ kind: "web", url: "https://example.au/app/goals/g1" });
    expect(notificationTarget(n({}), web)).toEqual({ kind: "none" });
    expect(orderedCategories({ zeta: { inApp: true, push: true }, chat: { inApp: true, push: true }, mention: { inApp: true, push: true } })).toEqual(["mention", "chat", "zeta"]);
  });
});

describe("chat and goal pushes", () => {
  it("route to the message resolver and the inbox, on the chat channel", () => {
    expect(routeForPush({ type: "chat.mention", id: "cmsg_1" })).toBe("/chat/message/cmsg_1");
    expect(routeForPush({ type: "chat.reply", id: "cmsg_2" })).toBe("/chat/message/cmsg_2");
    expect(routeForPush({ type: "chat.dm", id: "cmsg_3" })).toBe("/chat/message/cmsg_3");
    expect(routeForPush({ type: "goal.updated", id: "g1" })).toBe("/notifications");
    expect(channelFor("chat.dm")).toBe("chat");
    expect(fallbackText("chat.reply").title).toBe("New reply in a thread");
  });

  it("word the notification from the fetched message", async () => {
    const t = new SampleTransport();
    const api = endpoints(t);
    const { messages } = await api.chatMessages("chn_general", { limit: 50 });
    const mention = messages[messages.length - 1];
    const text = await describePush(api, { type: "chat.mention", id: mention.id });
    expect(text.title).toBe("Josh Tran mentioned you in #general");
    expect(text.body).toContain("@Mia Nguyen 12 kg house blend");
    const dm = await describePush(api, { type: "chat.dm", id: "cmsg_9" });
    expect(dm.title).toBe("Josh Tran");
    expect((await describePush(api, { type: "chat.dm", id: "missing" })).title).toBe("New direct message");
  });
});
