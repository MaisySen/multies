import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GOOGLE_G_COLOURS, GOOGLE_G_SRC, GoogleGLogo, GoogleSignInButton, ProviderButton, MicrosoftLogo } from "@/web/components/google-button";
import { GoogleMark } from "@/web/components/social-sign-in";
import { readFileSync } from "node:fs";

/** R29: the Google sign in button follows Google's branding guidelines. */
describe("Google sign in button (R29)", () => {
  it("uses Google's own downloadable G asset, nothing recoloured (R30)", () => {
    const html = renderToStaticMarkup(createElement(GoogleGLogo));
    expect(html).toContain(`src="${GOOGLE_G_SRC}"`);
    expect(html).toContain('width="20"');
    expect(html).toContain('height="20"');
    expect(html).toContain('alt=""');
    expect(html).not.toMatch(/currentColor|lucide/);
    // The sign in page's older name points at the same mark.
    expect(renderToStaticMarkup(createElement(GoogleMark))).toBe(html);
    // The file is Google's asset: the G's outline path from signin-assets.zip, its gradient stops,
    // the 20 x 20 crop, and no button frame.
    const svg = readFileSync(new URL("../public" + GOOGLE_G_SRC, import.meta.url), "utf8");
    expect(svg).toContain('viewBox="10 10 20 20"');
    expect(svg).toContain('d="M29.3987 18.1814H19.9849V22.0445H25.3598C25.1286 23.294 24.4294 24.3596 23.3676 25.0712');
    const rgb = (h: string) => `rgba(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)}, 1)`;
    for (const c of GOOGLE_G_COLOURS) expect(svg.includes(`fill="${c}"`) || svg.includes(rgb(c))).toBe(true);
    expect(svg).toContain("conic-gradient(");
    expect(svg).not.toContain("#747775");
    expect(svg).not.toMatch(/<script|on[a-z]+=/i);
    // The R29 hand drawn four colour paths are gone.
    for (const old of ["#EA4335", "#4285F4", "#FBBC05", "#34A853"]) expect(svg.toUpperCase()).not.toContain(old);
  });

  it("renders the G at 20 px on the left of an approved label, in the branded shell", () => {
    // React 19 hoists a preload link for the G image in server markup; the button follows it.
    const html = renderToStaticMarkup(createElement(GoogleSignInButton)).replace(/^<link rel="preload"[^>]*>/, "");
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
