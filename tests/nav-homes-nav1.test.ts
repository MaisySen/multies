/**
 * MPT-10 (NAV1 slice 1): every app page has a home in the menu. The test reads every /app route from
 * src/web/router.tsx with the TypeScript syntax tree, so the layout of a route object does not matter (one line or
 * many lines, any key order, before or after the Settings block). It skips detail routes (a path with an id, like
 * /app/tasks/:ref) and redirects (Moved). A page has a home when it is one of these:
 * - a rail entry or section in SECTIONS_P1 or SECTIONS_P2 (src/shared/nav-menu.ts);
 * - a Settings pane (SETTINGS_GROUPS or SETTINGS_GROUPS_P2);
 * - a Tools hub tile (buildEntries in src/web/components/tools/tool-directory.ts);
 * - a declared parent in NAV_PARENTS (src/shared/nav-parents.ts). The parent must have a home itself, and the declared
 *   file must link to the page: it is the parent's page module, a module that it imports, or the app shell
 *   (src/web/layouts), and the link is a to, href or navigate() value, not a comment.
 * A page with no home yet must be in NAV_NO_HOME_YET, with a reason and the NAV1 slice that gives it a home.
 * tests/nav-p2-r121.test.ts and tests/known-routes.test.ts check the other direction (every menu entry is a page).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { SECTIONS_P1, SECTIONS_P2 } from "@/shared/nav-menu";
import { NAV_NO_HOME_YET, NAV_PARENTS, type NavParent } from "@/shared/nav-parents";
import { SETTINGS_GROUPS, SETTINGS_GROUPS_P2 } from "@/web/pages/app/settings";
import { buildEntries, PAGE_FEATURES } from "@/web/components/tools/tool-directory";

type Route = { path: string; element: string };
const REDIRECTS = new Set(["Moved", "MovedSocial"]);

const sourceOf = (src: string, name = "router.tsx") => ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const propOf = (o: ts.ObjectLiteralExpression, name: string) =>
  o.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name);
/**
 * The page of a route element: <X /> and page(<X />) read as X. Any other form (for example a condition) reads as "",
 * so it is never taken for a redirect.
 */
function elementName(e: ts.Expression): string {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isJsxSelfClosingElement(e)) return e.tagName.getText();
  if (ts.isJsxElement(e)) return e.openingElement.tagName.getText();
  if (ts.isCallExpression(e) && e.arguments.length === 1) return elementName(e.arguments[0]);
  return "";
}
const isAppPath = (p: string) => p === "/app" || p.startsWith("/app/");
const isRouteObject = (o: ts.ObjectLiteralExpression) => !!propOf(o, "path") || !!propOf(o, "index") || (!!propOf(o, "children") && (!!propOf(o, "element") || !!propOf(o, "Component") || !!propOf(o, "lazy")));

/**
 * Every route under /app, with the name of its element. unparsed lists what the reader could not read (a route with a
 * path that is not a string, a spread that is not a redirect, an element that is not a route object). checked counts
 * every route object under /app found by a full walk of the syntax tree, and visited counts the ones the reader
 * followed. They must be equal, so the reader skips no route.
 */
export function appRoutes(src: string): { routes: Route[]; unparsed: string[]; checked: number; visited: number } {
  const sf = sourceOf(src);
  const routes: Route[] = [];
  const unparsed: string[] = [];
  let visited = 0;
  const roots: ts.ObjectLiteralExpression[] = [];
  const findRoots = (n: ts.Node) => {
    if (ts.isObjectLiteralExpression(n)) {
      const p = propOf(n, "path");
      if (p && ts.isStringLiteralLike(p.initializer) && isAppPath(p.initializer.text)) { roots.push(n); return; }
    }
    ts.forEachChild(n, findRoots);
  };
  findRoots(sf);
  const skipped = new Set<ts.Node>();
  const walk = (arr: ts.ArrayLiteralExpression, base: string) => {
    for (const el of arr.elements) {
      if (ts.isSpreadElement(el)) {
        // A spread of a list is read like the list. Any other spread is skipped only when every route in it is a redirect.
        if (ts.isArrayLiteralExpression(el.expression)) { walk(el.expression, base); continue; }
        const inner: ts.ObjectLiteralExpression[] = [];
        const find = (n: ts.Node) => { if (ts.isObjectLiteralExpression(n) && isRouteObject(n)) inner.push(n); ts.forEachChild(n, find); };
        find(el.expression);
        if (inner.length > 0 && inner.every((o) => { const el = propOf(o, "element"); return !!el && REDIRECTS.has(elementName(el.initializer)); })) { skipped.add(el); continue; }
        unparsed.push(`spread: ${el.getText(sf).slice(0, 80)}`);
        continue;
      }
      if (!ts.isObjectLiteralExpression(el)) { unparsed.push(`not a route object: ${el.getText(sf).slice(0, 80)}`); continue; }
      visit(el, base);
    }
  };
  const visit = (o: ts.ObjectLiteralExpression, base: string) => {
    visited++;
    const p = propOf(o, "path");
    const index = propOf(o, "index");
    const element = propOf(o, "element");
    const component = propOf(o, "Component") ?? propOf(o, "lazy");
    const children = propOf(o, "children");
    let path = base;
    if (p) {
      if (!ts.isStringLiteralLike(p.initializer)) { unparsed.push(`path is not a string: ${o.getText(sf).slice(0, 80)}`); return; }
      const v = p.initializer.text;
      path = v.startsWith("/") ? v : `${base}/${v}`;
    } else if (!(index && index.initializer.kind === ts.SyntaxKind.TrueKeyword) && !children) {
      unparsed.push(`route with no path: ${o.getText(sf).slice(0, 80)}`);
      return;
    }
    if (element) routes.push({ path, element: elementName(element.initializer) });
    else if (component) routes.push({ path, element: component.initializer.getText(sf).slice(0, 80) }); // Component: X or lazy: () => import(...)
    else if (!children) unparsed.push(`route with no element, Component or lazy: ${path}`);
    if (children) {
      if (ts.isArrayLiteralExpression(children.initializer)) walk(children.initializer, path);
      else unparsed.push(`children is not a list: ${path}`);
    }
  };
  for (const r of roots) visit(r, "");
  let checked = 0;
  const count = (n: ts.Node) => {
    if (skipped.has(n)) return;
    if (ts.isObjectLiteralExpression(n) && isRouteObject(n)) checked++;
    ts.forEachChild(n, count);
  };
  for (const r of roots) count(r);
  return { routes, unparsed, checked, visited };
}
const pagesOf = (routes: Route[]) => [...new Set(routes.filter((r) => !r.path.includes(":") && !REDIRECTS.has(r.element)).map((r) => r.path))];

const strip = (to: string) => to.replace(/[?#].*$/, "");
function menuHomes(): Set<string> {
  return new Set([
    ...[...SECTIONS_P1, ...SECTIONS_P2].flatMap((s) => [s.to, ...s.pages.map((p) => p.to)]),
    ...[...SETTINGS_GROUPS, ...SETTINGS_GROUPS_P2].flatMap((g) => g.items.map((p) => p.to)),
    ...buildEntries([], PAGE_FEATURES).flatMap((e) => (e.to ? [e.to] : [])),
  ].map(strip));
}

/** Pages with no menu entry, Settings pane, Tools tile, declared parent or allowlist entry. */
function missingHomes(pages: string[], homes: Set<string>, parents: Record<string, unknown>, noHomeYet: Record<string, unknown>): string[] {
  return pages.filter((p) => !homes.has(p) && !(p in parents) && !(p in noHomeYet));
}
const missingMessage = (missing: string[]) => missing.length === 0 ? "" :
  `These app pages have no home in the menu: ${missing.join(", ")}. Give each one a rail entry in src/shared/nav-menu.ts, a Settings pane, a Tools tile, or a declared parent in src/shared/nav-parents.ts (NAV_PARENTS).`;

/** Each declared parent must have a home: a menu home, or a declared parent with a home. No loops. */
function parentProblems(parents: Record<string, Pick<NavParent, "parent">>, homes: Set<string>): string[] {
  const problems: string[] = [];
  for (const route of Object.keys(parents)) {
    const seen = [route];
    let at = parents[route].parent;
    while (!homes.has(at)) {
      if (seen.includes(at)) { problems.push(`${route}: the parents make a loop (${[...seen, at].join(" -> ")})`); break; }
      if (!(at in parents)) { problems.push(`${route}: parent ${at} has no home. Give the parent a home first`); break; }
      seen.push(at);
      at = parents[at].parent;
    }
  }
  return problems;
}

/** The module files of a page component in the router: lazyPage(() => import("./x")), a helper that imports it, or a static import. */
function moduleOf(router: string, component: string): string | undefined {
  const sf = sourceOf(router);
  const decls = new Map<string, ts.Node>();
  const imports = new Map<string, string>();
  sf.forEachChild((n) => {
    if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) decls.set(d.name.text, d.initializer);
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings))
      for (const e of n.importClause.namedBindings.elements) imports.set(e.name.text, n.moduleSpecifier.text);
  });
  const dynamicImport = (n: ts.Node, depth: number): string | undefined => {
    let found: string | undefined;
    const v = (c: ts.Node) => {
      if (found) return;
      if (ts.isCallExpression(c) && c.expression.kind === ts.SyntaxKind.ImportKeyword && c.arguments[0] && ts.isStringLiteral(c.arguments[0])) { found = c.arguments[0].text; return; }
      if (ts.isCallExpression(c) && ts.isIdentifier(c.expression) && depth < 2 && decls.has(c.expression.text)) { found = dynamicImport(decls.get(c.expression.text)!, depth + 1); if (found) return; }
      ts.forEachChild(c, v);
    };
    v(n);
    return found;
  };
  const spec = decls.has(component) ? dynamicImport(decls.get(component)!, 0) : imports.get(component);
  return spec ? resolveModule("src/web/router.tsx", spec) : undefined;
}
function resolveModule(from: string, spec: string): string | undefined {
  const base = spec.startsWith("@/") ? join("src", spec.slice(2)) : spec.startsWith(".") ? normalize(join(dirname(from), spec)) : undefined;
  if (!base) return undefined;
  return [base, `${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")].find((f) => /\.tsx?$/.test(f) && existsSync(f));
}
/** The modules that a file imports (static imports and import() calls), resolved to files. */
function importsOf(file: string): string[] {
  const sf = sourceOf(readFileSync(file, "utf8"), file);
  const out: string[] = [];
  const v = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) { const f = resolveModule(file, n.moduleSpecifier.text); if (f) out.push(f); }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) { const f = resolveModule(file, n.arguments[0].text); if (f) out.push(f); }
    ts.forEachChild(n, v);
  };
  v(sf);
  return out;
}

/**
 * True when the code (not a comment) uses the route as a to, href or navigate() value, directly or through a const.
 * A link inside breadcrumb code (a function or a const whose name has "crumb") does not count: a breadcrumb shows only
 * on the page itself and its children, so it does not open the page from its parent.
 */
function linksTo(code: string, route: string): boolean {
  const sf = sourceOf(code, "file.tsx");
  const consts = new Map<string, string>();
  const values: ts.Expression[] = [];
  const crumb = (n: ts.Node) => (ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n) || ts.isMethodDeclaration(n) || ts.isPropertyAssignment(n)) && !!n.name && /crumb/i.test(n.name.getText());
  const v = (n: ts.Node) => {
    if (crumb(n)) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isStringLiteralLike(n.initializer)) consts.set(n.name.text, n.initializer.text);
    if (ts.isJsxAttribute(n) && ["to", "href"].includes(n.name.getText()) && n.initializer) values.push(ts.isJsxExpression(n.initializer) ? n.initializer.expression! : n.initializer as ts.Expression);
    if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) && ["to", "href"].includes(n.name.text)) values.push(n.initializer);
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "navigate" && n.arguments[0]) values.push(n.arguments[0]);
    ts.forEachChild(n, v);
  };
  v(sf);
  const matches = (s: string) => s === route || s.startsWith(`${route}?`) || s.startsWith(`${route}#`);
  const linked = (e: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(e)) return linked(e.expression);
    if (ts.isConditionalExpression(e)) return linked(e.whenTrue) || linked(e.whenFalse);
    if (ts.isStringLiteralLike(e)) return matches(e.text);
    if (ts.isTemplateExpression(e)) return matches(e.head.text);
    if (ts.isIdentifier(e)) return matches(consts.get(e.text) ?? "");
    return false;
  };
  return values.filter(Boolean).some(linked);
}

const FORBIDDEN_FILES = ["src/shared/nav-parents.ts", "src/web/lib/palette-registry.ts"];
/** Why a declared parent's file does not count as a link from the parent page, or "" when it counts. */
function fileProblem(route: string, d: NavParent, parentModule: string | undefined, code: string | undefined): string {
  if (FORBIDDEN_FILES.includes(d.file)) return `${route}: ${d.file} is not a page. The command palette and this list do not count as a home`;
  if (!d.file.startsWith("src/web/")) return `${route}: ${d.file} must be a file under src/web`;
  if (code === undefined) return `${route}: ${d.file} does not exist`;
  const shell = d.file.startsWith("src/web/layouts/");
  const ofParent = !!parentModule && (d.file === parentModule || importsOf(parentModule).includes(d.file));
  if (!shell && !ofParent) return `${route}: ${d.file} is not the page module of ${d.parent} (${parentModule ?? "not found"}), a module that it imports, or the app shell`;
  if (!linksTo(code, route)) return `${route}: ${d.file} does not link to it`;
  return "";
}

const router = readFileSync("src/web/router.tsx", "utf8");
const read = appRoutes(router);
const pages = pagesOf(read.routes);
const homes = menuHomes();
const elementOf = (path: string) => read.routes.find((r) => r.path === path)?.element;

describe("every app page has a menu home (MPT-10, NAV1 slice 1)", () => {
  it("reads every /app route in the router, and skips only detail routes and redirects", () => {
    expect(read.unparsed).toEqual([]);
    expect(read.visited).toBe(read.checked);
    expect(pages.length).toBeGreaterThan(80);
    for (const p of ["/app", "/app/tasks", "/app/settings", "/app/settings/team", "/app/contacts/staff"]) expect(pages).toContain(p);
    for (const p of ["/app/tasks/:ref", "/app/integrations", "/app/settings/connections"]) expect(pages).not.toContain(p);
  });

  it("gives every page a home: a rail entry, a Settings pane, a Tools tile, a declared parent, or the allowlist", () => {
    expect(missingMessage(missingHomes(pages, homes, NAV_PARENTS, NAV_NO_HOME_YET))).toBe("");
  });

  it("declares each parent for a real page, the parent has a home, and the parent's page links to the page", () => {
    expect(parentProblems(NAV_PARENTS, homes)).toEqual([]);
    for (const [route, d] of Object.entries(NAV_PARENTS)) {
      expect(pages, route).toContain(route);
      expect(homes.has(route), `${route} has a menu home now: remove it from NAV_PARENTS`).toBe(false);
      expect(route in NAV_NO_HOME_YET, `${route} is in NAV_PARENTS and NAV_NO_HOME_YET`).toBe(false);
      expect(pages, `${route}: parent ${d.parent} is not an app page`).toContain(d.parent);
      const parentModule = moduleOf(router, elementOf(d.parent) ?? "");
      const code = existsSync(d.file) ? readFileSync(d.file, "utf8") : undefined;
      expect(fileProblem(route, d, parentModule, code)).toBe("");
      expect(d.reason.trim().length, route).toBeGreaterThan(0);
    }
  });

  it("lists each page without a home with a reason and the NAV1 slice that will give it one", () => {
    for (const [route, d] of Object.entries(NAV_NO_HOME_YET)) {
      expect(pages, route).toContain(route);
      expect(homes.has(route) || route in NAV_PARENTS, `${route} has a home now: remove it from NAV_NO_HOME_YET`).toBe(false);
      expect(d.reason.trim().length, route).toBeGreaterThan(0);
      expect(d.slice, route).toMatch(/^NAV1 /);
    }
  });

  it("fails for a new route without a home, and names the route and the fix", () => {
    const missing = missingHomes([...pages, "/app/new-page"], homes, NAV_PARENTS, NAV_NO_HOME_YET);
    expect(missing).toEqual(["/app/new-page"]);
    expect(missingMessage(missing)).toContain("/app/new-page");
    expect(missingMessage(missing)).toContain("src/shared/nav-parents.ts");
  });

  it("fails when a page leaves the allowlist without getting a home", () => {
    for (const route of Object.keys(NAV_NO_HOME_YET)) {
      const rest = Object.fromEntries(Object.entries(NAV_NO_HOME_YET).filter(([r]) => r !== route));
      expect(missingHomes(pages, homes, NAV_PARENTS, rest)).toEqual([route]);
    }
  });

  it("counts every Tools tile feature, so each tile is a home", () => {
    expect(PAGE_FEATURES.length).toBeGreaterThan(10);
    expect(new Set(PAGE_FEATURES).size).toBe(PAGE_FEATURES.length);
    expect(PAGE_FEATURES).not.toContain("");
  });
});

describe("the route reader and the checks catch bad input (MPT-10 review R2 to R4, R8 and R9)", () => {
  const FIXTURE = `
const routes = [
  { path: "/", element: <Home /> },
  {
    path: "/app",
    element: <AppLayout />,
    children: [
      { index: true, element: page(<Dash />) },
      {
        path: "multi-line",
        element: page(<Multi />),
      },
      { element: page(<Reversed />), path: "element-first" },
      {path:"tight",element:<Tight />},
      // a comment with ], and { path: "in-a-comment", element: <Ghost /> }
      ...APP_MOVES.map((m) => ({ path: m.path, element: <Moved to={m.to} /> })),
      {
        path: "settings",
        element: <SettingsLayout />,
        children: [{ index: true, element: <SettingsHome /> }, { path: "team", element: <Team /> }],
      },
      { path: "after-settings", element: page(<After />) },
      { path: "tasks/:ref", element: page(<TaskDetail />) },
    ],
  },
];`;

  it("finds a route on many lines, with element first, with no spaces, and after the Settings block", () => {
    const r = appRoutes(FIXTURE);
    expect(r.unparsed).toEqual([]);
    expect(r.visited).toBe(r.checked);
    expect(pagesOf(r.routes).sort()).toEqual(["/app", "/app/after-settings", "/app/element-first", "/app/multi-line", "/app/settings", "/app/settings/team", "/app/tight"]);
  });

  it("reads Component and lazy routes, and a page in a spread with a redirect (review R8, verifier D5)", () => {
    const more = FIXTURE.replace('{ path: "after-settings"', [
      '{ path: "comp", Component: CompPage },',
      '{ path: "lazy", lazy: () => import("./pages/app/lazy") },',
      '...[{ path: "old", element: <Moved to="/app" /> }, { path: "sneaky", element: page(<Sneaky />) }],',
      '{ path: "after-settings"',
    ].join(" "));
    const r = appRoutes(more);
    expect(r.unparsed).toEqual([]);
    expect(r.visited).toBe(r.checked);
    for (const p of ["/app/comp", "/app/lazy", "/app/sneaky"]) expect(pagesOf(r.routes)).toContain(p);
    expect(pagesOf(r.routes)).not.toContain("/app/old");
    const mixed = appRoutes(FIXTURE.replace("<Moved to={m.to} />", "m.old ? <Moved to={m.to} /> : page(<Page />)"));
    expect(mixed.unparsed.join(" ")).toContain("spread: ...APP_MOVES");
    expect(appRoutes(FIXTURE.replace('{ path: "after-settings", element: page(<After />) }', '{ path: "after-settings" }')).unparsed).toEqual(["route with no element, Component or lazy: /app/after-settings"]);
  });

  it("reports a route that it cannot read, so the test fails instead of skipping it", () => {
    const r = appRoutes(FIXTURE.replace('{ path: "after-settings"', 'flag ? { path: "hidden" } : null, { path: "after-settings"').replace('path:"tight"', "path:TIGHT"));
    expect(r.unparsed.length).toBe(2);
    expect(r.unparsed.join(" ")).toContain("flag ?");
    expect(r.unparsed.join(" ")).toContain("path is not a string");
  });

  it("fails a declared parent that has no home, and a loop of parents", () => {
    const h = new Set(["/app/contacts"]);
    expect(parentProblems({ "/app/a": { parent: "/app/contacts" }, "/app/b": { parent: "/app/a" } }, h)).toEqual([]);
    expect(parentProblems({ "/app/labels": { parent: "/app/no-home" } }, h)).toEqual(["/app/labels: parent /app/no-home has no home. Give the parent a home first"]);
    expect(parentProblems({ "/app/x": { parent: "/app/y" }, "/app/y": { parent: "/app/x" } }, h)[0]).toContain("loop");
  });

  it("refuses this list, the command palette, files outside src/web, files of another page, and a link in a comment", () => {
    const d = (file: string): NavParent => ({ parent: "/app/contacts", file, reason: "test" });
    const mod = "src/web/pages/app/work/contacts.tsx";
    expect(fileProblem("/app/analyses", d("src/shared/nav-parents.ts"), mod, "")).toContain("is not a page");
    expect(fileProblem("/app/analyses", d("src/web/lib/palette-registry.ts"), mod, "")).toContain("is not a page");
    expect(fileProblem("/app/analyses", d("tests/nav-homes-nav1.test.ts"), mod, "")).toContain("must be a file under src/web");
    expect(fileProblem("/app/analyses", d("src/web/pages/app/inbox.tsx"), mod, 'const a = <Link to="/app/analyses" />;')).toContain("is not the page module");
    expect(fileProblem("/app/analyses", d(mod), mod, '// <Link to="/app/analyses" />\nconst a = 1;')).toContain("does not link to it");
    expect(fileProblem("/app/analyses", d(mod), mod, 'const a = <Link to="/app/analyses?tab=x" />;')).toBe("");
    expect(fileProblem("/app/analyses", d(mod), mod, 'const a = <NavLink to={x ? "/app/analyses" : y} />;')).toBe("");
    expect(fileProblem("/app/analyses", d("src/web/layouts/shell-nav.ts"), mod, 'export const A = "/app/analyses";\nconst m = { to: A };')).toBe("");
    expect(fileProblem("/app/analyses", d("src/web/layouts/shell-nav.ts"), mod, 'export function breadcrumbs() { return [{ label: "A", to: "/app/analyses" }]; }')).toContain("does not link to it");
  });
});
