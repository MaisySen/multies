import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GOOGLE_G_COLOURS, GoogleGLogo, GoogleSignInButton, ProviderButton, MicrosoftLogo } from "@/web/components/google-button";
import { GoogleMark } from "@/web/components/social-sign-in";
import { readFileSync } from "node:fs";

/** R29: the Google sign in button follows Google's branding guidelines. */
describe("Google sign in button (R29)", () => {
  it("draws Google's standard four colour G, nothing recoloured", () => {
    const svg = renderToStaticMarkup(createElement(GoogleGLogo));
    const fills = [...svg.matchAll(/fill="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1].toUpperCase());
    expect(fills).toEqual(["#EA4335", "#4285F4", "#FBBC05", "#34A853"]);
    expect(new Set(fills)).toEqual(new Set(GOOGLE_G_COLOURS));
    expect(svg).toContain('viewBox="0 0 48 48"');
    expect(svg).not.toMatch(/currentColor|lucide/);
    // The old approximation's colours are gone.
    for (const old of ["#FFC107", "#FF3D00", "#4CAF50", "#1976D2"]) expect(svg).not.toContain(old);
    // The sign in page's older name points at the same mark.
    expect(renderToStaticMarkup(createElement(GoogleMark))).toBe(svg);
  });

  it("renders the G at 20 px on the left of an approved label, in the branded shell", () => {
    const html = renderToStaticMarkup(createElement(GoogleSignInButton));
    expect(html).toMatch(/^<button type="button"/);
    expect(html).toContain("mm-provider-btn");
    expect(html).toMatch(/class="[^"]*\bh-10\b[^"]*\bpx-3\b[^"]*\bgap-2\.5\b|class="[^"]*\bgap-2\.5\b/);
    expect(html).toContain("text-sm font-medium");
    const logoAt = html.indexOf('data-testid="google-g"');
    const labelAt = html.indexOf("Continue with Google");
    expect(logoAt).toBeGreaterThan(0);
    expect(labelAt).toBeGreaterThan(logoAt);
    expect(html).toContain('class="h-5 w-5"'); // 20 px
    expect(renderToStaticMarkup(createElement(GoogleSignInButton, { label: "Sign in with Google" }))).toContain("Sign in with Google");
  });

  it("shows a spinner in place of the logo while busy, and is disabled", () => {
    const html = renderToStaticMarkup(createElement(GoogleSignInButton, { loading: true }));
    expect(html).toContain("disabled");
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('data-testid="google-g"');
    expect(html).toContain("Continue with Google");
  });

  it("other providers share the same shell", () => {
    const ms = renderToStaticMarkup(createElement(ProviderButton, { logo: createElement(MicrosoftLogo) }, "Continue with Microsoft"));
    expect(ms).toContain("mm-provider-btn");
    expect(ms).toContain("Continue with Microsoft");
  });

  it("styles light and dark with Google's fill and border colours", () => {
    const css = readFileSync(new URL("../src/web/index.css", import.meta.url), "utf8").toLowerCase();
    const block = css.slice(css.indexOf(".mm-provider-btn {"));
    expect(block).toMatch(/background-color: #ffffff;\s*border: 1px solid #747775;\s*color: #1f1f1f;/);
    expect(block).toContain(':root[data-theme="dark"] .mm-provider-btn { background-color: #131314; border-color: #8e918f; color: #e3e3e3; }');
    expect(block).toContain(':root:not([data-theme="light"]) .mm-provider-btn { background-color: #131314; border-color: #8e918f; color: #e3e3e3; }');
  });
});
