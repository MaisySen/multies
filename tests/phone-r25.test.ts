import { describe, expect, it } from "vitest";
import { composerHint, pickTaskView } from "../src/web/lib/phone";

describe("R25 DF-10: the Tasks view a person opens with", () => {
  it("phones open the List and wider screens the Board when nothing was chosen", () => {
    expect(pickTaskView({ phone: true })).toBe("list");
    expect(pickTaskView({ phone: false })).toBe("board");
    expect(pickTaskView({ param: null, stored: null, phone: true })).toBe("list");
  });
  it("a view in the address wins over everything", () => {
    expect(pickTaskView({ param: "board", stored: "list", phone: true })).toBe("board");
    expect(pickTaskView({ param: "timeline", phone: false })).toBe("timeline");
  });
  it("keeps the view this person last picked on the device, also on a phone", () => {
    expect(pickTaskView({ stored: "board", phone: true })).toBe("board");
    expect(pickTaskView({ stored: "calendar", phone: false })).toBe("calendar");
  });
  it("ignores a view name it does not know", () => {
    expect(pickTaskView({ param: "gallery", stored: "kanban", phone: true })).toBe("list");
    expect(pickTaskView({ param: "", stored: "<script>", phone: false })).toBe("board");
  });
});

describe("R25 DF-10: the chat composer hint", () => {
  it("shows the keyboard hints only where there is a keyboard", () => {
    expect(composerHint({ touch: false, projectKey: "WEB" })).toMatch(/^Enter to send, Shift Enter for a new line\./);
    expect(composerHint({ touch: true, projectKey: "WEB" })).not.toMatch(/Enter/);
  });
  it("uses a real project key of the workspace, never a made up one", () => {
    expect(composerHint({ touch: true, projectKey: "WEB" })).toBe("Type @ to mention, or a task ref like WEB-1 to link it.");
    expect(composerHint({ touch: false })).not.toMatch(/OPS-12/);
    expect(composerHint({ touch: true, projectKey: null })).toBe("Type @ to mention, or a task ref to link it.");
  });
  it("drops a key that is not a task ref prefix", () => {
    expect(composerHint({ touch: true, projectKey: "web stuff" })).toBe("Type @ to mention, or a task ref to link it.");
    expect(composerHint({ touch: true, projectKey: "TOOLONGKEY" })).toBe("Type @ to mention, or a task ref to link it.");
  });
});
