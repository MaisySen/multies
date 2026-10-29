import { bodyText, htmlToText, linkSegments } from "../src/lib/mail-body";

describe("mail body on the phone (R56b)", () => {
  it("turns <https://...> into a tappable link without the brackets", () => {
    const segs = linkSegments("Hi Bidur,\nNew device signed in <https://myaccount.google.com/notifications>.\nThanks");
    const link = segs.find((s) => s.kind === "link");
    expect(link).toEqual({ kind: "link", text: "https://myaccount.google.com/notifications", url: "https://myaccount.google.com/notifications" });
    expect(segs.map((s) => s.text).join("")).toBe("Hi Bidur,\nNew device signed in https://myaccount.google.com/notifications.\nThanks");
  });
  it("links email addresses and bare www, drops [image: X] placeholders", () => {
    const segs = linkSegments("[image: Google]\nWrite to help@fintex.au or www.multies.si today");
    expect(segs.filter((s) => s.kind === "link").map((s) => (s as { url: string }).url)).toEqual(["mailto:help@fintex.au", "https://www.multies.si"]);
    expect(segs.map((s) => s.text).join("")).not.toContain("[image");
  });
  it("gives HTML only mail a readable text version with links", () => {
    const html = '<html><head><style>p{}</style></head><body><p>Hello&nbsp;there</p><p><a href="https://x.com/a?b=1&amp;c=2">Open it</a></p><img src="x"/><ul><li>One</li></ul></body></html>';
    const t = htmlToText(html);
    expect(t).toContain("Hello there");
    expect(t).toContain("Open it <https://x.com/a?b=1&c=2>");
    expect(t).toContain("\u2022 One");
    expect(bodyText({ text: "", html })).toBe(t);
    expect(bodyText({ text: "plain", html })).toBe("plain");
  });
});
