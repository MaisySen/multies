import { describe, expect, it } from "vitest";
import { shouldOpenDefaultChannel } from "../src/web/pages/app/work/chat-list-r49";

describe("R49 chat list on phones", () => {
  it("opens the default channel on /app/chat", () => {
    expect(shouldOpenDefaultChannel({ hasDefault: true, listParam: null, phone: true })).toBe(true);
    expect(shouldOpenDefaultChannel({ hasDefault: true, listParam: null, phone: false })).toBe(true);
  });
  it("stays on the channel list when a phone asked for it (Back)", () => {
    expect(shouldOpenDefaultChannel({ hasDefault: true, listParam: "1", phone: true })).toBe(false);
  });
  it("ignores the list flag on wider screens (the list is always beside the channel)", () => {
    expect(shouldOpenDefaultChannel({ hasDefault: true, listParam: "1", phone: false })).toBe(true);
  });
  it("does nothing when a channel is open or there is none yet", () => {
    expect(shouldOpenDefaultChannel({ channelId: "chn_1", hasDefault: true, listParam: null, phone: true })).toBe(false);
    expect(shouldOpenDefaultChannel({ hasDefault: false, listParam: null, phone: true })).toBe(false);
  });
});
