import { describe, expect, it } from "vitest";
import { AUTH_CARD_PATH, authCardPage, LOGIN_VARIANTS, loginHtmlFor, loginVariantKey, type LoginPrerender, type LoginVariant } from "../src/shared/prerender-shell";
import { inertFormFields, prerendersAuthCard, renderAuthCard } from "../src/web/prerender";

const shell = '<html><head></head><body><div id="root"></div></body></html>';
const prod: LoginVariant = { idp: true, password: false, google: false, github: false, demo: true };
const local: LoginVariant = { idp: false, password: true, google: false, github: false, demo: false };

describe("R35 prerendered sign up and forgot password cards", () => {
  it("knows the three card paths and nothing else", () => {
    expect(authCardPage("/login")).toBe("login");
    expect(authCardPage("/signup/")).toBe("signup");
    expect(authCardPage("/forgot-password")).toBe("forgot");
    for (const p of ["/reset-password", "/signupx", "/app/signup", "/forgot", "/"]) {
      expect(authCardPage(p)).toBeNull();
      expect(AUTH_CARD_PATH.test(p)).toBe(false);
    }
  });

  it("serves each page its own card, no query only, and the shell when a variant is missing", () => {
    const k = loginVariantKey(prod);
    const pre: LoginPrerender = { shell, cards: { [k]: "<main>in</main>" }, pages: { signup: { [k]: "<main>up</main>" }, forgot: { [k]: "<main>reset</main>" } } };
    expect(loginHtmlFor("/signup", "", pre, prod)).toContain("<main>up</main>");
    expect(loginHtmlFor("/forgot-password/", "", pre, prod)).toContain("<main>reset</main>");
    expect(loginHtmlFor("/login", "", pre, prod)).toContain("<main>in</main>");
    expect(loginHtmlFor("/signup", "?invited=1&email=a%40b.c", pre, prod)).toBeNull();
    expect(loginHtmlFor("/forgot-password", "?email=a%40b.c", pre, prod)).toBeNull();
    expect(loginHtmlFor("/signup", "", pre, local)).toBeNull();
    expect(loginHtmlFor("/signup", "", { shell, cards: pre.cards }, prod)).toBeNull(); // an R34 build: no pages
  });

  it("renders sign up for every setup and forgot password only where the identity provider owns passwords", () => {
    for (const v of LOGIN_VARIANTS) {
      const up = renderAuthCard("signup", v);
      expect(up).toContain("Create your account");
      expect(up).toContain('href="/terms"');
      expect(up).toContain('href="/acceptable-use"');
      expect(prerendersAuthCard("signup", v)).toBe(true);
    }
    expect(prerendersAuthCard("forgot", prod)).toBe(true);
    expect(prerendersAuthCard("forgot", local)).toBe(false);
    expect(prerendersAuthCard("forgot", { ...prod, password: true })).toBe(false);
    const reset = renderAuthCard("forgot", prod);
    expect(reset).toContain("Reset your password");
    expect(reset).toContain("Email me a reset link");
    expect(renderAuthCard("signup", prod)).toContain("Free for startups and small teams");
    expect(renderAuthCard("signup", local)).toContain("new-password");
  });

  it("draws the form fields read only and the submit button inert until the app takes over", () => {
    const up = renderAuthCard("signup", local);
    expect(up).not.toMatch(/<input(?![^>]*readonly)/);
    expect(up).not.toContain('type="submit"');
    expect(up).toContain('href="/login"');
    expect(inertFormFields('<input type="hidden" name="x"/><input readonly="" name="y"/><input name="z"/>')).toBe('<input type="hidden" name="x"/><input readonly="" name="y"/><input readonly="" name="z"/>');
  });
});
