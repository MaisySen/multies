import { dayLabel, groupMessages, GROUP_GAP_MS } from "@/lib/chat-group";
import { animateList, listMotionAllowed, SPRING } from "@/lib/motion";
import { motion } from "@/theme";
import type { ChatMessage } from "@/api/types";

const now = new Date(2026, 9, 27, 12, 0, 0);
const m = (id: string, author: string, at: Date, extra: Partial<ChatMessage> = {}) => ({
  id, channelId: "c", parentId: null, author: { type: "member", id: author, name: author }, body: id, mentions: [], links: [], attachments: [],
  replyCount: 0, lastReplyAt: null, editedAt: null, deleted: false, createdAt: at.toISOString(), updatedAt: at.toISOString(), ...extra,
}) as ChatMessage;

it("labels days like a messenger", () => {
  expect(dayLabel(new Date(2026, 9, 27, 8), now)).toBe("Today");
  expect(dayLabel(new Date(2026, 9, 26, 23), now)).toBe("Yesterday");
  expect(dayLabel(new Date(2026, 9, 20, 9), now)).toBe("Tuesday 20 October");
  expect(dayLabel(new Date(2025, 11, 31, 9), now)).toBe("Wednesday 31 December 2025");
});

it("groups the same person within five minutes and puts a day line between days", () => {
  const y = new Date(2026, 9, 26, 10, 0);
  const t = new Date(2026, 9, 27, 9, 0);
  const items = groupMessages([
    m("a", "ana", y), m("b", "ana", new Date(y.getTime() + 60_000)),
    m("c", "ana", t), m("d", "ana", new Date(t.getTime() + GROUP_GAP_MS + 1)), m("e", "bo", new Date(t.getTime() + GROUP_GAP_MS + 2)),
    m("f", "bo", new Date(t.getTime() + GROUP_GAP_MS + 3), { deleted: true }),
  ], now);
  expect(items.map((i) => i.kind === "day" ? `[${i.label}]` : `${i.id}${i.grouped ? "+" : ""}`)).toEqual(["[Yesterday]", "a", "b+", "[Today]", "c", "d", "e", "f"]);
});

it("one spring and one list fade, off with Reduce Motion and on the web", () => {
  expect(SPRING).toBe(motion.spring);
  expect(listMotionAllowed({ platform: "ios", reduce: false })).toBe(true);
  expect(listMotionAllowed({ platform: "ios", reduce: true })).toBe(false);
  expect(listMotionAllowed({ platform: "web", reduce: false })).toBe(false);
  expect(() => animateList()).not.toThrow();
});
