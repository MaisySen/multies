/**
 * MFIX1 (1.10.16): meetings, recordings, downloads and exports open in the phone's own browser
 * (Linking.openURL), signed in with a one time link on this server; the in-app browser is only the fallback.
 * Other pages stay inside the app. Mock only.
 */
import { Linking, Platform } from "react-native";
import { API_BASE } from "@/config";
import type { Transport } from "@/api/transport";
import { openMeeting, meetingTarget } from "@/lib/meetings";
import { opensInSystemBrowser, openInSystemBrowser, openWeb, registerWebTransport, resetWebLink } from "@/lib/web-open";

jest.mock("expo-router", () => ({ router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), navigate: jest.fn(), canGoBack: () => true } }));

const WebBrowser = require("expo-web-browser");
const code = "A".repeat(32);
const request = jest.fn(async () => ({ code }));
const signedTransport = { request } as unknown as Pick<Transport, "request">;
const openURL = Linking.openURL as unknown as jest.Mock;

beforeEach(() => {
  openURL.mockReset(); openURL.mockImplementation(async () => true);
  WebBrowser.openBrowserAsync.mockClear();
  request.mockClear();
  resetWebLink();
  registerWebTransport(null);
  Platform.OS = "ios";
});

describe("which pages leave the app", () => {
  it.each([
    ["/app/meetings", true], ["/app/meetings/mtg_1", true], ["/app/meetings/mtg_1?join=1", true], ["/app/tools/compare", false],
    ["/app/meetings/mtg_1/recordings", true], ["/app/docs/d1/export", true], ["/app/files/f1/download", true],
    ["/app/docs", false], ["/app/settings/apps/mail", false], ["/app", false], ["/app/meetingsx", false], ["/app/mail?q=/export", false],
  ])("%s -> %s", (path, out) => { expect(opensInSystemBrowser(path)).toBe(out); });
});

describe("openMeeting", () => {
  it("opens this server's meeting page in the phone's browser, signed in", async () => {
    registerWebTransport(signedTransport);
    await openMeeting(`${API_BASE}/app/meetings/mtg_1`);
    expect(openURL).toHaveBeenCalledWith(`${API_BASE}/auth/mobile/web?code=${code}&next=${encodeURIComponent("/app/meetings/mtg_1")}`);
    expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
  });
  it("opens the plain link without a session", async () => {
    await openMeeting(`${API_BASE}/app/meetings/mtg_1`);
    expect(openURL).toHaveBeenCalledWith(`${API_BASE}/app/meetings/mtg_1`);
  });
  it("opens an outside https meeting link as given", async () => {
    registerWebTransport(signedTransport);
    expect(await meetingTarget("https://meet.example.org/abc")).toBe("https://meet.example.org/abc");
    await openMeeting("https://meet.example.org/abc");
    expect(openURL).toHaveBeenCalledWith("https://meet.example.org/abc");
    expect(request).not.toHaveBeenCalled();
  });
  it("falls back to the in-app browser when the phone refuses", async () => {
    openURL.mockImplementation(async () => { throw new Error("no browser"); });
    await openMeeting("https://meet.example.org/abc");
    expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith("https://meet.example.org/abc", expect.objectContaining({ dismissButtonStyle: "done" }));
  });
  it("never opens another scheme", async () => {
    expect(await openInSystemBrowser("javascript:alert(1)")).toBe("none");
    expect(await openInSystemBrowser("intent://x")).toBe("none");
    expect(openURL).not.toHaveBeenCalled();
    expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
  });
  it("opens a new tab on the web preview", async () => {
    Platform.OS = "web";
    const open = jest.fn(); (globalThis as { open?: unknown }).open = open;
    await openMeeting("https://meet.example.org/abc");
    expect(open).toHaveBeenCalledWith("https://meet.example.org/abc", "_blank", "noopener");
    expect(openURL).not.toHaveBeenCalled();
  });
});

describe("openWeb", () => {
  it("keeps ordinary pages inside the app", async () => {
    registerWebTransport(signedTransport);
    await openWeb("/app/docs");
    expect(WebBrowser.openBrowserAsync).toHaveBeenCalled();
    expect(openURL).not.toHaveBeenCalled();
  });
  it("sends meeting notes on the web to the phone's browser, signed in", async () => {
    registerWebTransport(signedTransport);
    await openWeb("/app/meetings/mtg_1");
    expect(openURL).toHaveBeenCalledWith(expect.stringContaining("/auth/mobile/web?code="));
    expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
  });
  it("sends a recording page to the phone's browser without a session", async () => {
    await openWeb("/app/meetings/mtg_1/recordings");
    expect(openURL).toHaveBeenCalledWith(`${API_BASE}/app/meetings/mtg_1/recordings`);
  });
});

describe("What's new 1.10.16 in the language on screen", () => {
  const { whatsNewText } = require("@/components/ota");
  const { setLangForTests } = require("@/i18n");
  const raw = { title: "Meetings open in your phone's browser", body: "x" };
  afterAll(() => setLangForTests("en"));
  it.each(["en", "ne", "hi"])("%s has its own words", (l) => {
    setLangForTests(l);
    const it2 = whatsNewText("1.10.16", 0, raw);
    expect(it2.title.length).toBeGreaterThan(5);
    expect(it2.body).not.toMatch(/[\u2013\u2014]/);
    if (l !== "en") expect(it2.title).not.toBe(raw.title);
  });
  it("older versions keep the changelog words", () => { expect(whatsNewText("1.10.15", 0, raw)).toBe(raw); });
});
