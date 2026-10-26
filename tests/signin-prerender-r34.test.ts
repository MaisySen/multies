import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { injectAuthCard, LOGIN_BOOT, LOGIN_VARIANTS, startCodeAfterPaint, loginHtmlFor, loginVariantKey, withCriticalCss, type LoginPrerender, type LoginVariant } from "../src/shared/prerender-shell";
import { loginVariant, providersAnswer } from "../src/server/auth/config";
import { classesIn, criticalCss, selectorClasses } from "../scripts/critical-css";
import { renderLoginCard } from "../src/web/prerender";

const shell = '<html><head><link rel="stylesheet" crossorigin href="/assets/index-abc.css"></head><body><div id="root"></div></body></html>';
const auth = (over: Record<string, unknown> = {}) => ({ localPassword: false, auth0: undefined, social: {}, ...over }) as never;
const prodLike = { auth: auth({ auth0: { domain: "login.multies.si" } }), demoEnabled: true };
const localLike = { auth: auth(), demoEnabled: false };

describe("R34 prerendered sign in card: variant pick", () => {
  it("reads the setup the way the providers answer does", () => {
    expect(providersAnswer(prodLike)).toEqual({ idp: true, password: false, google: false, github: false, auth0: true });
    expect(loginVariant(prodLike)).toEqual({ idp: true, password: false, google: false, github: false, demo: true, social: "" });
    expect(loginVariant(localLike)).toEqual({ idp: false, password: true, google: false, github: false, demo: false, social: "" });
    expect(loginVariant({ auth: auth({ social: { google: {}, github: {} } }), demoEnabled: true })).toMatchObject({ google: true, github: true });
    // With the identity provider on, direct social buttons are off whatever is configured.
    expect(loginVariant({ auth: auth({ auth0: { domain: "x" }, social: { google: {} } }), demoEnabled: false }).google).toBe(false);
  });

  it("prerenders every setup a deployment can have, each once", () => {
    const keys = LOGIN_VARIANTS.map(loginVariantKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const cfg of [prodLike, localLike, { auth: auth({ auth0: { domain: "x" }, localPassword: true }), demoEnabled: false }, { auth: auth({ social: { github: {} } }), demoEnabled: true }]) {
      expect(keys).toContain(loginVariantKey(loginVariant(cfg)));
    }
  });

  it("serves the card for plain /login only, and the plain shell otherwise", () => {
    const v: LoginVariant = { idp: true, password: false, google: false, github: false, demo: true };
    const pre: LoginPrerender = { shell, cards: { [loginVariantKey(v)]: "<main>card</main>" } };
    const html = loginHtmlFor("/login", "", pre, v)!;
    expect(html).toContain('<div id="root" data-prerendered="auth"><main>card</main></div>');
    expect(loginHtmlFor("/login/", "", pre, v)).toBe(html);
    expect(loginHtmlFor("/login", "?error=oauth", pre, v)).toBeNull();
    expect(loginHtmlFor("/login", "?next=%2Fapp", pre, v)).toBeNull();
    expect(loginHtmlFor("/signup", "", pre, v)).toBeNull();
    expect(loginHtmlFor("/login", "", pre, { ...v, demo: false })).toBeNull();
    expect(loginHtmlFor("/login", "", null, v)).toBeNull();
    expect(loginHtmlFor("/login", "", pre, null)).toBeNull();
    expect(() => injectAuthCard("<div id=\"root\">x</div>", "<p>a</p>")).toThrow();
  });
});

describe("R34 prerendered sign in card: markup", () => {
  it("draws the card for each setup, the same markup the app renders once its reads are back", () => {
    const idp = renderLoginCard({ idp: true, password: false, google: false, github: false, demo: false });
    expect(idp).toContain("Welcome back");
    expect(idp).toContain('aria-label="Multies home"');
    expect(idp).not.toContain('name="password"');
    expect(idp).not.toContain("Explore a demo workspace");
    const local = renderLoginCard({ idp: false, password: true, google: false, github: false, demo: true });
    expect(local).toContain('name="email"');
    expect(local).toContain('name="password"');
    expect(local).toContain("Explore a demo workspace");
    expect(local).toContain("Create an account");
    expect(local).not.toContain("auth-hold");
    expect(renderLoginCard({ idp: false, password: true, google: true, github: true, demo: false })).toContain('data-testid="social-github"');
  });
});

describe("R34 critical CSS", () => {
  it("unescapes class names in selectors", () => {
    expect(selectorClasses(".hover\\:underline:hover")).toEqual(["hover:underline"]);
    expect(selectorClasses(".bg-surface\\/80 .p-1\\.5")).toEqual(["bg-surface/80", "p-1.5"]);
    expect(selectorClasses(".text-\\[24px\\]")).toEqual(["text-[24px]"]);
    expect(selectorClasses("html, :root, [data-theme=dark]")).toEqual([]);
    expect([...classesIn('<a class="x y  z"></a><b class="[&amp;_svg]:shrink-0"></b>')]).toEqual(["x", "y", "z", "[&_svg]:shrink-0"]);
  });

  it("keeps the rules the HTML uses, in order, and drops the rest", () => {
    const css = "@layer theme{:root{--a:1}}@property --tw-x{syntax:'*';inherits:false}@layer utilities{.p-7{padding:1.75rem}.unused{color:red}.hover\\:underline{&:hover{text-decoration:underline}}@media (width>=40rem){.sm\\:flex{display:flex}}.a,.unused2{margin:0}}@keyframes spin{to{rotate:360deg}}";
    const out = criticalCss(css, ['<div class="p-7 hover:underline a"></div>']);
    expect(out).toContain(":root{--a:1}");
    expect(out).toContain("@property --tw-x");
    expect(out).toContain(".p-7{padding:1.75rem}");
    expect(out).toContain("text-decoration:underline");
    expect(out).toMatch(/\.a\s*\{margin:0\}/);
    expect(out).not.toContain("unused");
    expect(out).not.toContain("sm\\:flex");
    expect(out).not.toContain("@media");
    expect(out).not.toContain("@keyframes");
    expect(criticalCss(css, ['<i class="animate-spin"></i>'])).toContain("@keyframes spin");
  });

  it("inlines the CSS and makes the main stylesheet non-blocking, with a noscript copy", () => {
    const html = withCriticalCss(shell, ".a{color:red}");
    expect(html).toContain("<style data-critical>.a{color:red}</style>");
    expect(html).toContain('<link rel="stylesheet" crossorigin href="/assets/index-abc.css" media="print" data-defer-css>');
    expect(html).toContain('<noscript><link rel="stylesheet" crossorigin href="/assets/index-abc.css"></noscript>');
    expect(html.indexOf("<style data-critical>")).toBeLessThan(html.indexOf("media=\"print\""));
    // No inline script, so the page's CSP needs no new hash.
    expect(html).not.toMatch(/<script>|onload=/);
    expect(withCriticalCss(shell, "</style><script>x</script>")).not.toContain("</style><script>");
    expect(() => withCriticalCss("<html></html>", ".a{}")).toThrow();
  });
});

describe("R34 sign in code starts after the card has painted", () => {
  it("moves the module script and its preloads into the boot file's data attributes", () => {
    const html = '<head>\n    <script type="module" crossorigin src="/assets/index-1.js"></script>\n    <link rel="modulepreload" crossorigin href="/assets/a.js">\n    <link rel="modulepreload" crossorigin href="/assets/b.js">\n</head>';
    const out = startCodeAfterPaint(html);
    expect(out).toContain(`<script src="${LOGIN_BOOT}" defer data-entry="/assets/index-1.js" data-preload="/assets/a.js /assets/b.js"></script>`);
    expect(out).not.toContain('type="module"');
    expect(out).not.toContain("modulepreload");
    expect(() => startCodeAfterPaint("<head></head>")).toThrow();
    const boot = readFileSync(`public${LOGIN_BOOT}`, "utf8");
    expect(boot).toContain("requestAnimationFrame");
    expect(boot).toContain('s.type = "module"');
  });
});
