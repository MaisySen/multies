import { describe, expect, it } from "vitest";
import { matchPanes, paneFor, SETTINGS_GROUPS } from "@/web/pages/app/settings";

/** R38: the grouped settings rail and phone hub (premium pass 3). */
describe("settings panes", () => {
  it("lists every settings route once, in four groups", () => {
    const all = SETTINGS_GROUPS.flatMap((g) => g.items.map((i) => i.to));
    expect(SETTINGS_GROUPS.map((g) => g.label)).toEqual(["Workspace", "You", "Mail", "Build"]);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(15); // C1 added Chat channels; R77 Branding and Appearance
  });
  it("names the pane you are on, General for the hub and its phone alias", () => {
    expect(paneFor("/app/settings").label).toBe("General");
    expect(paneFor("/app/settings/general").label).toBe("General");
    expect(paneFor("/app/settings/team").label).toBe("Team");
    expect(paneFor("/app/settings/sign-up-emails/").label).toBe("Sign-up emails");
  });
  it("finds panes by name and by what is inside them", () => {
    expect(matchPanes("").length).toBe(15);
    expect(matchPanes("logo").map((p) => p.label)).toContain("Branding"); // R77
    expect(matchPanes("dark").map((p) => p.label)).toContain("Appearance");
    expect(matchPanes("passkey").map((p) => p.label)).toEqual(["Account & security"]);
    expect(matchPanes("api keys").map((p) => p.label)).toContain("Developers");
    expect(matchPanes("INVITE").map((p) => p.label)).toEqual(["Team"]);
    expect(matchPanes("zzzz")).toEqual([]);
  });
});
