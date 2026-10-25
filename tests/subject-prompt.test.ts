import { describe, expect, it } from "vitest";
import { shouldAskForSubject, SUBJECT_PROMPT } from "@/web/lib/subject-prompt";

describe("the empty subject prompt in compose", () => {
  it("asks once when the subject is empty or only spaces", () => {
    expect(shouldAskForSubject("", false)).toBe(true);
    expect(shouldAskForSubject("   ", false)).toBe(true);
  });
  it("never blocks: after asking, Send sends", () => {
    expect(shouldAskForSubject("", true)).toBe(false);
  });
  it("doesn't ask when there is a subject", () => {
    expect(shouldAskForSubject("Invoice 12", false)).toBe(false);
    expect(shouldAskForSubject("Re: hello", false)).toBe(false);
  });
  it("says why, in plain words", () => {
    expect(SUBJECT_PROMPT).toBe("Add a subject? Mail without one is more likely to go to spam.");
  });
});
