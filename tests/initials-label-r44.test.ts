import { describe, expect, it } from "vitest";
import { initials, initialsLabel } from "@/web/lib/format";

/** R44: a11y.spec:16, the board card assignee button shows initials, so its name must contain them (WCAG 2.5.3). */
describe("initialsLabel (R44)", () => {
  // The same token rule axe uses: lower case words, bracketed text removed, visible words a contiguous run of the name.
  const words = (s: string) => s.replace(/\([^()]*\)/g, "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const contains = (name: string, visible: string) => {
    const n = words(name).join(" ");
    return ` ${n} `.includes(` ${words(visible).join(" ")} `);
  };

  it("names the role, the initials shown and the full name", () => {
    expect(initialsLabel("Assignee", "Alex Rivera")).toBe("Assignee: AR, Alex Rivera");
  });

  it("contains the visible initials as a whole word, outside brackets", () => {
    for (const name of ["Alex Rivera", "ann brown", "Mia", "jo.smith@example.com", "Zoë Ngata Kahu"]) {
      const label = initialsLabel("Assignee", name);
      expect(contains(label, initials(name)), label).toBe(true);
      expect(label).toContain(name);
    }
  });

  it("the R43 bracketed form fails the same rule (why it was replaced)", () => {
    expect(contains("Assignee: Alex Rivera (AR)", "AR")).toBe(false);
  });
});
