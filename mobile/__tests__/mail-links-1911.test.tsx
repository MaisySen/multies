import { Linking, Text } from "react-native";
import { fireEvent, render } from "@testing-library/react-native";
import { linkLabel, linkSegments } from "../src/lib/mail-body";
import { LinkedText } from "../src/components/linked-text";
import { colors } from "../src/theme";

// 1.9.11: the owner's screenshot (30 Oct 2026, a GitHub Actions mail on an iPhone in dark mode): the
// addresses were plain white text, not tappable, and wrapped in the middle of a word.
const GITHUB_MAIL = [
  "[MaisySen/nsw-transport-app] Run failed: CI - main (0e5c1d2)",
  "",
  "View results: https://github.com/MaisySen/nsw-transport-app/actions/runs/40926009018",
  "",
  "Jobs:",
  "  * build failed (1 annotation)",
  "",
  "Finished: 2026-10-29 18:00:17 UTC",
  "",
  "-- ",
  "You are receiving this because you are subscribed to this thread.",
  "Manage your GitHub Actions notifications here: https://github.com/settings/notifications",
  "Unsubscribe: https://github.com/notifications/unsubscribe-auth/AAQX7Y3ZJQK5LNCXW2R4M5T3ZQHGFAVCNFSM6AAAAABXYZ123456789ABCDEFGH?email_source=notifications&email_token=ABCD1234.",
].join("\n");

const ZW = /\u200b/g;
const links = (t: string) => linkSegments(t).filter((s) => s.kind === "link") as { kind: "link"; text: string; url: string }[];

describe("links in the GitHub notification from the screenshot (1.9.11)", () => {
  it("finds every address with its exact url, without the trailing full stop", () => {
    expect(links(GITHUB_MAIL).map((l) => l.url)).toEqual([
      "https://github.com/MaisySen/nsw-transport-app/actions/runs/40926009018",
      "https://github.com/settings/notifications",
      "https://github.com/notifications/unsubscribe-auth/AAQX7Y3ZJQK5LNCXW2R4M5T3ZQHGFAVCNFSM6AAAAABXYZ123456789ABCDEFGH?email_source=notifications&email_token=ABCD1234",
    ]);
    expect(linkSegments(GITHUB_MAIL).map((s) => s.text).join("")).toBe(GITHUB_MAIL);
  });

  it("shortens long addresses to the site and the last parts, and short ones keep their path", () => {
    const [run, settings, unsub] = links(GITHUB_MAIL);
    expect(linkLabel(run).replace(ZW, "")).toBe("github.com/\u2026/actions/runs/40926009018");
    expect(linkLabel(settings).replace(ZW, "")).toBe("github.com/settings/notifications");
    const u = linkLabel(unsub).replace(ZW, "");
    expect(u.startsWith("github.com/\u2026/")).toBe(true);
    expect(u.length).toBeLessThanOrEqual(48);
    expect(linkLabel(links("https://multies.si/settings/domains/harbourcoffee.com.au/records/verification-report-2026-10-29")[0]).replace(ZW, "")).toBe("multies.si/\u2026/verification-report-2026-10-29");
    expect(u).not.toContain("?");
  });

  it("only offers line breaks between parts of an address, never inside a word", () => {
    const label = linkLabel(links(GITHUB_MAIL)[0]);
    for (const piece of label.split("\u200b")) expect(piece === "" || /\/$/.test(piece) || piece === label.split("\u200b").pop()).toBe(true);
    expect(label).toContain("runs/\u200b40926009018");
  });

  it("leaves email addresses and short links as they are", () => {
    const [mail, site] = links("Write to help@multies.si or see https://multies.si.");
    expect(linkLabel(mail)).toBe("help@multies.si");
    expect(mail.url).toBe("mailto:help@multies.si");
    expect(linkLabel(site).replace(ZW, "")).toBe("multies.si");
  });

  it("renders links in the brand colour, underlined, and a tap opens the full address", async () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    const screen = await render(<Text testID="body"><LinkedText text={GITHUB_MAIL} testID="b" /></Text>);
    const linksShown = screen.getAllByRole("link");
    expect(linksShown).toHaveLength(3);
    for (const l of linksShown) expect(l).toHaveStyle({ color: colors.brand, textDecorationLine: "underline" });
    expect(screen.getByText("github.com/\u200b\u2026/\u200bactions/\u200bruns/\u200b40926009018")).toBeTruthy();
    await fireEvent.press(linksShown[0]);
    expect(open).toHaveBeenCalledWith("https://github.com/MaisySen/nsw-transport-app/actions/runs/40926009018");
    // Plain text around the links stays plain (no colour of its own, so it takes the body colour).
    expect(screen.getByText(/Finished: 2026-10-29 18:00:17 UTC/)).not.toHaveStyle({ color: colors.brand });
  });
});
