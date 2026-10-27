import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error plain ESM script without types
import { copyProblems, fixSentenceSpacing, fixTextBreaks } from "../scripts/auth0-r41-copy.mjs";

describe("R41 MB-223 and MB-233: identity provider copy", () => {
  it("puts a space after a full stop when the next sentence follows straight on", () => {
    expect(fixSentenceSpacing("join your team.The link works for 5 days.")).toBe("join your team. The link works for 5 days.");
    expect(fixSentenceSpacing("join your team.<b>The</b> link")).toBe("join your team. <b>The</b> link");
    expect(fixSentenceSpacing("join your team.</p><p>The link")).toBe("join your team.</p><p>The link");
    expect(fixSentenceSpacing("multies.si and v1.2 stay")).toBe("multies.si and v1.2 stay");
    expect(fixSentenceSpacing("works.Then go")).toBe("works. Then go");
  });
  it("the hosted page copy is sentence case, with no exclamation marks or dashes", () => {
    const copy = JSON.parse(readFileSync("deploy/auth0/r41-copy.json", "utf8"));
    expect(copyProblems(copy)).toEqual([]);
    expect(JSON.stringify(copy)).not.toMatch(/Password Changed!|Create Your Account|to continue to Multies to continue/);
    expect(copyProblems({ prompts: { x: { en: { y: { title: "Password Changed!" } } } } }).length).toBeGreaterThan(0);
    expect(copy.client.initiate_login_uri).toBe("https://multies.si/login?confirmed=1");
  });
});

describe("R45 (MB-233) text part line breaks", () => {
  it("puts a line break after each table row and each <br>, once", () => {
    const html = '<tr><td>join your team.</td></tr><tr><td>The link works.</td></tr>\r\n<tr><td>browser:<br><a href="x">x</a></td></tr>';
    const fixed = fixTextBreaks(html);
    expect(fixed).toBe('<tr><td>join your team.</td></tr>\r\n<tr><td>The link works.</td></tr>\r\n<tr><td>browser:<br>\r\n<a href="x">x</a></td></tr>');
    expect(fixTextBreaks(fixed)).toBe(fixed);
  });
});
