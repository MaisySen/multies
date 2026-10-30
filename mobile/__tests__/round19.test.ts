/**
 * Round 19: the app signs in on the Multies tenant (multies.au.auth0.com), and Compose asks
 * gently before sending mail with no subject (never blocks the send).
 */
import { askAboutEmptySubject, EMPTY_SUBJECT_PROMPT, needsSubjectPrompt } from "@/lib/subject-prompt";

describe("sign in tenant", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; jest.resetModules(); });

  it("uses the Multies tenant and its native client by default", () => {
    delete process.env.EXPO_PUBLIC_IDP_DOMAIN;
    delete process.env.EXPO_PUBLIC_IDP_CLIENT_ID;
    const { IDP } = require("@/config");
    expect(IDP.domain).toBe("multies.au.auth0.com");
    expect(IDP.clientId).toBe("W6wGvtK6pZYMwLakl3aZrMoOd4mU1fbF");
    expect(IDP.redirectUri).toBe("mymail://auth/callback");
  });

  it("never falls back to the old development tenant host", () => {
    const { IDP } = require("@/config");
    expect(IDP.domain).not.toMatch(/^dev-/);
    expect(IDP.domain).not.toContain("us.auth0.com");
  });

  it("still lets a build point at another tenant", () => {
    process.env.EXPO_PUBLIC_IDP_DOMAIN = "https://example.au.auth0.com/";
    process.env.EXPO_PUBLIC_IDP_CLIENT_ID = "abc";
    const { IDP } = require("@/config");
    expect(IDP).toMatchObject({ domain: "example.au.auth0.com", clientId: "abc" });
  });
});

describe("empty subject prompt", () => {
  it("asks only when the subject is empty or blank", () => {
    expect(needsSubjectPrompt("")).toBe(true);
    expect(needsSubjectPrompt("   ")).toBe(true);
    expect(needsSubjectPrompt(undefined)).toBe(true);
    expect(needsSubjectPrompt("Invoice 42")).toBe(false);
  });

  it("says it plainly with Add subject and Send anyway", () => {
    const alert = jest.fn();
    void askAboutEmptySubject(alert);
    const [title, message, buttons] = alert.mock.calls[0];
    expect(title).toBe("Add a subject?");
    expect(message).toBe("Mail without one is more likely to go to spam.");
    expect(buttons.map((b: { text: string }) => b.text)).toEqual(["Add subject", "Send anyway"]);
    expect(`${title} ${message}`).not.toMatch(/[\u2013\u2014]/);
  });

  it("Send anyway goes ahead", async () => {
    const alert = jest.fn((_t, _m, buttons) => buttons[1].onPress());
    await expect(askAboutEmptySubject(alert)).resolves.toBe(true);
  });

  it("Add subject stops the send so the person can type one", async () => {
    const alert = jest.fn((_t, _m, buttons) => buttons[0].onPress());
    await expect(askAboutEmptySubject(alert)).resolves.toBe(false);
  });

  it("a dismissed dialog does not send", async () => {
    const alert = jest.fn((_t, _m, _b, opts) => opts.onDismiss());
    await expect(askAboutEmptySubject(alert)).resolves.toBe(false);
  });

  it("keeps the copy in one place", () => {
    expect(EMPTY_SUBJECT_PROMPT).toEqual({ title: "Add a subject?", message: "Mail without one is more likely to go to spam.", add: "Add subject", send: "Send anyway" });
  });
});
