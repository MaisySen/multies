/**
 * R121 (layout plan P2, NAV_P2_R121): one menu model. Every page reachable from the old rail, the old phone list and the
 * Settings sidebar is still reachable from the P2 menu (or its old address redirects to a page that is), for every
 * combination of switches; nothing new shows for anyone; old addresses map to their new homes; hide and reset rules.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as nav from "@/web/layouts/shell-nav";
import {
  canHide, cleanFourthTab, cleanHidden, COUNT_KEYS, MAIL_SETUP, movedPath, navHref, sectionBadge, SECTIONS_P1, SECTIONS_P2, visibleIn, withoutHidden,
  type NavFlagKey, type NavFlagSet,
} from "@/shared/nav-menu";
import { SETTINGS_GROUPS, SETTINGS_GROUPS_P2, paneFor } from "@/web/pages/app/settings";
import { activePhoneTabP2 } from "@/web/components/phone-tab-bar";
import { DEFAULT_LAYOUT, sanitize } from "@/web/lib/layout-prefs";
import { menuFor } from "@/server/routes/nav-menu-r121";
import { isKnownPage } from "@/shared/known-routes";

afterEach(() => nav.setNavModel(false));

const FLAGS: NavFlagKey[] = ["sites", "tools", "files", "scheduling", "operator", "flows", "socialP2", "helpCenter", "socialP2b", "docsPlus"];
/** Every switch combination would be 1024 cases; all off, all on, each one alone and each one missing covers every page rule. */
const COMBOS: NavFlagSet[] = [
  {}, Object.fromEntries(FLAGS.map((f) => [f, true])),
  ...FLAGS.map((f) => ({ [f]: true })),
  ...FLAGS.map((f) => Object.fromEntries(FLAGS.map((g) => [g, g !== f]))),
];

/** The old phone and tablet list (app.tsx `nav`, plus Tools, Files, Booking page and Operator added by switch). */
function oldPhoneList(flags: NavFlagSet): string[] {
  const src = readFileSync("src/web/layouts/app.tsx", "utf8");
  const block = src.slice(src.indexOf("const nav: NavItem[] = ["), src.indexOf("];", src.indexOf("const nav: NavItem[] = [")));
  const tos = [...block.matchAll(/to: "([^"]+)"/g)].map((m) => m[1]);
  expect(tos.length).toBeGreaterThan(20);
  return [...tos, ...(flags.tools ? ["/app/tools"] : []), ...(flags.files ? ["/app/files"] : []), ...(flags.scheduling ? ["/app/scheduling"] : []), ...(flags.operator ? ["/console"] : [])]; // OPS1: the operator console moved from /app/admin
}
const settingsPanes = (groups: typeof SETTINGS_GROUPS, flags: NavFlagSet) => groups.flatMap((g) => g.items).map((p) => p.to).filter((to) => to !== "/console" || !!flags.operator); // OPS1

function p2Reachable(flags: NavFlagSet): Set<string> {
  return new Set([...visibleIn(SECTIONS_P2, flags).flatMap((s) => s.pages.map((p) => p.to)), ...settingsPanes(SETTINGS_GROUPS_P2, flags), nav.SOCIAL_NEW]);
}

describe("R121 reachability: no route lost", () => {
  it("every page of the old rail, old phone list and Settings sidebar is reachable in P2, for every switch combination", () => {
    for (const flags of COMBOS) {
      const old = new Set([...visibleIn(SECTIONS_P1, flags).flatMap((s) => s.pages.map((p) => p.to)), ...oldPhoneList(flags), ...settingsPanes(SETTINGS_GROUPS, flags)]);
      const reach = p2Reachable(flags);
      const lost = [...old].filter((to) => !reach.has(movedPath(to) ?? to));
      expect(lost, JSON.stringify(flags)).toEqual([]);
    }
  });
  it("P2 shows nothing a person could not open before (same switches, nothing new for any role)", () => {
    for (const flags of COMBOS) {
      const old = new Set([...visibleIn(SECTIONS_P1, flags).flatMap((s) => s.pages.map((p) => p.to)), ...oldPhoneList(flags), ...settingsPanes(SETTINGS_GROUPS, flags)].map((to) => movedPath(to) ?? to));
      // Deals had no menu entry but was always open to every member by address (/app/deals); it is the one new entry.
      const extra = [...p2Reachable(flags)].filter((to) => !old.has(to) && to !== nav.SOCIAL_NEW && to !== "/app/deals");
      expect(extra, JSON.stringify(flags)).toEqual([]);
    }
  });
  it("Operator stays with platform admins only, in the rail and in Settings", () => {
    expect(p2Reachable({}).has("/console")).toBe(false); // OPS1: the operator console moved from /app/admin
    expect(p2Reachable({ operator: true }).has("/console")).toBe(true);
  });
  it("every P2 address is a page the server knows (no 404 for a menu entry)", () => {
    for (const to of p2Reachable(Object.fromEntries(FLAGS.map((f) => [f, true])))) expect(isKnownPage(to), to).toBe(true);
  });
  it("the router has a route for each Mail setup page and still has the old ones", () => {
    const r = readFileSync("src/web/router.tsx", "utf8");
    for (const p of ["mailboxes", "domains", "domains/:id", "deliverability"]) expect(r.split(`{ path: "${p}"`).length - 1, p).toBe(2);
  });
});

describe("R121 placement (layout plan section 3)", () => {
  it("rail order: Home, Mail, Chat, Tasks, Docs, Social, Contacts, Tools, Dashboards, then Agents and Settings", () => {
    expect(SECTIONS_P2.map((s) => s.id)).toEqual(["home", "mail", "chat", "tasks", "docs", "social", "contacts", "tools", "dashboards", "agents", "workspace"]);
  });
  it("Contacts is its own section with People and Deals, out of Chat", () => {
    const c = SECTIONS_P2.find((s) => s.id === "contacts")!;
    expect(c.pages.map((p) => [p.label, p.to])).toEqual([["People", "/app/contacts"], ["Deals", "/app/deals"]]);
    expect(SECTIONS_P2.find((s) => s.id === "chat")!.pages.map((p) => p.to)).not.toContain("/app/contacts");
  });
  it("Mail keeps only the daily pages; setup lives in Settings, Mail setup", () => {
    expect(SECTIONS_P2.find((s) => s.id === "mail")!.pages.map((p) => p.label)).toEqual(["Mail", "Shared inbox"]);
    const ms = SETTINGS_GROUPS_P2.find((g) => g.label === "Mail setup")!;
    expect(ms.items.slice(0, 4).map((p) => p.label)).toEqual(["Mailboxes", "Domains", "Deliverability", "Routing"]);
    expect(MAIL_SETUP.map((m) => m.label)).toEqual(["Mailboxes", "Domains", "Deliverability", "Routing"]);
  });
  it("Files joins Docs with the same switch and address; Tools keeps Tools and Convert", () => {
    const docs = SECTIONS_P2.find((s) => s.id === "docs")!;
    expect(docs.pages.find((p) => p.label === "Files")).toEqual({ to: "/app/files", label: "Files", icon: "files", flag: "files" });
    expect(SECTIONS_P2.find((s) => s.id === "tools")!.pages.map((p) => p.label)).toEqual(["Tools", "Convert files"]);
  });
  it("Social, Home, Dashboards, Agents and Settings are the very same objects as P1 (later Social entries flow through)", () => {
    for (const id of ["home", "social", "dashboards", "agents", "workspace"]) expect(SECTIONS_P2.find((s) => s.id === id)).toBe(SECTIONS_P1.find((s) => s.id === id));
  });
  it("Settings keeps one sidebar; Import and export joins Workspace; other groups unchanged", () => {
    expect(SETTINGS_GROUPS_P2.map((g) => g.label)).toEqual(SETTINGS_GROUPS.map((g) => (g.label === "Mail" ? "Mail setup" : g.label)));
    expect(SETTINGS_GROUPS_P2.find((g) => g.label === "Workspace")!.items.map((p) => p.to)).toContain("/app/settings/import");
    expect(SETTINGS_GROUPS_P2.find((g) => g.label === "You")).toBe(SETTINGS_GROUPS.find((g) => g.label === "You"));
  });
});

describe("R121 the switch: off is the old navigation, unchanged", () => {
  it("off: the P1 model, titles and crumbs", () => {
    nav.setNavModel(false);
    expect(nav.activeSections()).toBe(SECTIONS_P1);
    expect(nav.SECTIONS).toBe(SECTIONS_P1);
    expect(nav.sectionFor("/app/contacts").id).toBe("chat");
    expect(nav.sectionFor("/app/files").id).toBe("tools");
    expect(nav.appHref("/app/domains/d1?x=1")).toBe("/app/domains/d1?x=1");
    expect(paneFor("/app/settings/mail").label).toBe("Mail routing");
  });
  it("on: Contacts, Files in Docs, Mail setup crumbs and titles", () => {
    nav.setNavModel(true);
    expect(nav.sectionFor("/app/contacts/invoices").id).toBe("contacts");
    expect(nav.sectionFor("/app/deals").id).toBe("contacts");
    expect(nav.sectionFor("/app/files").id).toBe("docs");
    expect(nav.sectionFor("/app/chat").id).toBe("chat");
    expect(nav.breadcrumbs("/app/settings/domains/abc", "").map((c) => c.label)).toEqual(["Settings", "Domains"]);
    expect(nav.breadcrumbs("/app/settings/mail", "").map((c) => c.label)).toEqual(["Settings", "Routing"]);
    expect(nav.pageTitle("/app/settings/mailboxes")).toBe("Mailboxes · Settings · Multies");
    expect(nav.appHref("/app/mailboxes?tab=aliases")).toBe("/app/settings/mailboxes?tab=aliases");
    expect(paneFor("/app/settings/domains/abc").label).toBe("Domains");
    expect(paneFor("/app/settings/mail").label).toBe("Routing");
  });
});

describe("R121 old addresses redirect", () => {
  const cases: [string, string][] = [
    ["/app/mailboxes", "/app/settings/mailboxes"], ["/app/mailboxes/", "/app/settings/mailboxes"], ["/app/mailboxes?tab=aliases", "/app/settings/mailboxes?tab=aliases"],
    ["/app/domains", "/app/settings/domains"], ["/app/domains?add=1", "/app/settings/domains?add=1"], ["/app/domains/d_123", "/app/settings/domains/d_123"],
    ["/app/domains/d_123?check=1#dkim", "/app/settings/domains/d_123?check=1#dkim"], ["/app/deliverability", "/app/settings/deliverability"], ["/app/deliverability#bounces", "/app/settings/deliverability#bounces"],
  ];
  it.each(cases)("%s goes to %s", (from, to) => expect(movedPath(from)).toBe(to));
  it("addresses that did not move stay (and lookalikes are not caught)", () => {
    for (const p of ["/app/mail", "/app/contacts", "/app/deals", "/app/files", "/app/domainsx", "/app/settings/domains", "/app/settings/mail", "/app/tools/links/domain"]) expect(movedPath(p), p).toBeNull();
    expect(navHref("/app/domains", false)).toBe("/app/domains");
    expect(navHref("/app/domains", true)).toBe("/app/settings/domains");
  });
  it("the Worker and the Node server redirect old addresses with 302 only while the switch is on", () => {
    const w = readFileSync("src/entry/worker.ts", "utf8");
    expect(w).toMatch(/NAV_P2_R121[\s\S]{0,200}movedPath\(url\.pathname\)[\s\S]{0,120}status: 302/);
    expect(readFileSync("src/entry/node.ts", "utf8")).toMatch(/config\.navP2R121 \? movedPath\(c\.req\.path\)[\s\S]{0,120}302/);
  });
});

describe("R121 hide and reset", () => {
  const P2 = visibleIn(SECTIONS_P2, {});
  it("Home and Settings cannot be hidden; unknown or repeated ids are dropped", () => {
    expect(canHide("home")).toBe(false);
    expect(canHide("workspace")).toBe(false);
    expect(cleanHidden(["contacts", "home", "nope", "contacts", 3, "workspace", "tools"])).toEqual(["contacts", "tools"]);
    expect(cleanHidden("contacts")).toEqual([]);
  });
  it("hidden sections leave the rail, but the one you are in stays", () => {
    expect(withoutHidden(P2, ["contacts", "dashboards"]).map((s) => s.id)).not.toContain("contacts");
    expect(withoutHidden(P2, ["contacts"], "contacts").map((s) => s.id)).toContain("contacts");
    expect(withoutHidden(P2, ["home", "workspace"]).map((s) => s.id)).toEqual(P2.map((s) => s.id));
  });
  it("prefs: the default shows everything with Tasks as the fourth tab; bad stored values fall back", () => {
    expect(DEFAULT_LAYOUT.railHidden).toEqual([]);
    expect(DEFAULT_LAYOUT.fourthTab).toBe("tasks");
    expect(sanitize({ railHidden: ["social", "home"], fourthTab: "social" })).toMatchObject({ railHidden: ["social"], fourthTab: "social" });
    expect(sanitize({ railHidden: "x", fourthTab: "games" })).toMatchObject({ railHidden: [], fourthTab: "tasks" });
    expect(cleanFourthTab("docs")).toBe("docs");
  });
});

describe("R121 counts and phone tabs", () => {
  it("the rail badge and the More tile use one number: alerts first, else the calm unread total", () => {
    const home = SECTIONS_P2.find((s) => s.id === "home")!;
    const mail = SECTIONS_P2.find((s) => s.id === "mail")!;
    const counts = { "/app/notifications": { n: 3, label: "3 unread", alert: true }, "/app/triage": { n: 2, label: "2", alert: true }, "/app/mail": { n: 12, label: "12 unread" } };
    expect(sectionBadge(home, counts)).toEqual({ n: 5, alert: true });
    expect(sectionBadge(mail, counts)).toEqual({ n: 12, alert: false });
    expect(sectionBadge(SECTIONS_P2.find((s) => s.id === "contacts")!, counts)).toEqual({ n: 0, alert: false });
  });
  it("phone tabs: Home, Mail, Chat, the fourth tab, More; other pages light up More", () => {
    expect(activePhoneTabP2("/app/chat/c1", "", "tasks")).toBe("chat");
    expect(activePhoneTabP2("/app/tasks", "", "tasks")).toBe("tasks");
    expect(activePhoneTabP2("/app/tasks", "?view=calendar", "calendar")).toBe("calendar");
    expect(activePhoneTabP2("/app/tasks", "", "social")).toBe("more");
    expect(activePhoneTabP2("/app/social/posts", "", "social")).toBe("social");
    expect(activePhoneTabP2("/app/docs/abc", "", "docs")).toBe("docs");
    expect(activePhoneTabP2("/app/contacts", "", "tasks")).toBe("more");
  });
});

describe("R121 GET /api/nav/menu (the model the mobile app reads)", () => {
  const base = { config: { navP2R121: true, tools: { enabled: true, features: ["folders"] }, filesPlus: true, schedulingEnabled: true, socialP2: true, socialP2b: true, flows: true } } as never;
  it("on: the P2 sections, Mail setup, phone tabs and count keys", () => {
    const m = menuFor(base, { role: "member" });
    expect(m.navP2).toBe(true);
    expect(m.sections.map((s) => s.id)).toEqual(["home", "mail", "chat", "tasks", "docs", "social", "contacts", "tools", "dashboards", "agents", "workspace"]);
    expect(m.mailSetup.map((x) => x.label)).toEqual(["Mailboxes", "Domains", "Deliverability", "Routing"]);
    expect(m.phoneTabs.order).toEqual(["home", "mail", "chat", "fourth", "more"]);
    const mailPage = m.sections.find((s) => s.id === "mail")!.pages[0] as { count?: string };
    expect(mailPage.count).toBe(COUNT_KEYS["/app/mail"]);
  });
  it("members never get Operator; a platform admin does; off answers the P1 model", () => {
    const pages = (m: ReturnType<typeof menuFor>) => m.sections.flatMap((s) => s.pages.map((p) => p.to));
    // OPS1: the console (/console on the web) goes to the phone as /app/admin, which opens /console: the phone's menu
    // parser (mobile/src/lib/nav-menu.ts) and its one time web sign in link accept only /app pages.
    expect(pages(menuFor(base, { role: "member" }))).not.toContain("/app/admin");
    expect(pages(menuFor(base, { role: "owner", platformRole: "admin" }))).toContain("/app/admin");
    expect(pages(menuFor(base, { role: "member", platformRole: "ops_readonly" }))).toContain("/app/admin");
    for (const navP2R121 of [true, false]) {
      const m = menuFor({ config: { ...(base as { config: object }).config, navP2R121 } } as never, { role: "owner", platformRole: "admin" });
      for (const to of [...m.sections.map((s) => s.to), ...pages(m), ...m.mailSetup.map((x) => x.to)]) expect(to, to).toMatch(/^\/app(\/|$)/);
    }
    const off = menuFor({ config: { tools: { enabled: false, features: [] } } } as never, { role: "admin" });
    expect(off.navP2).toBe(false);
    expect(off.sections.map((s) => s.id)).toEqual(["home", "mail", "tasks", "docs", "social", "chat", "dashboards", "agents", "workspace"]);
    expect(off.mailSetup).toEqual([]);
    expect(pages(off)).not.toContain("/app/files");
  });
  it("Sites is marked as shown once used, so the app asks before listing it", () => {
    const m = menuFor({ config: { ...(base as { config: object }).config, sites: true } } as never, { role: "admin" });
    expect(m.sections.find((s) => s.id === "docs")!.pages.find((p) => p.to === "/app/docs/sites")).toMatchObject({ whenUsed: "/api/sites/in-use" });
  });
});
