/**
 * OPS1: the console's shared tabs in query mode (components/detail-tabs.tsx), rendered to static markup like the other
 * component tests: an ARIA tablist with one selected tab, links that reset every other filter except `keep`, hidden
 * tabs for a role without the permission, and a panel labelled by the current tab.
 */
import { describe, it, expect } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConsoleGuard } from "../src/web/pages/console/guard";
import { QueryTabs, TabPanel, queryTabSearch, type DetailTab } from "../src/web/pages/console/components/detail-tabs";
import { consoleKeys, type ConsoleMe } from "../src/web/lib/console-api";
import type { Permission } from "../src/shared/operator-permissions";

const TABS: DetailTab[] = [
  { id: "failures", label: "Webhook failures" },
  { id: "keys", label: "API keys", badge: createElement("span", null, "3") },
  { id: "secret", label: "Billing only", permission: "billing.read" as Permission },
];

function render(url: string, node: ReactNode, permissions: Permission[] = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const me = { user: { id: "u", email: "op@example.test", name: "Op" }, role: "support", roleLabel: "Support", permissions, twoFactor: true } as unknown as ConsoleMe;
  qc.setQueryData(consoleKeys.me, me);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, { initialEntries: [url] }, createElement(ConsoleGuard, null, node))));
}

/** The opening tag of the tab link with this test id. */
const tab = (html: string, testId: string) => html.match(new RegExp(`<a[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";

describe("queryTabSearch", () => {
  it("keeps only the named parameters, and the first tab has no ?tab=", () => {
    const p = new URLSearchParams("tab=keys&q=acme&status=failed&orgId=org_1&cursor=abc");
    expect(queryTabSearch(p, "failures", true)).toBe("");
    expect(queryTabSearch(p, "keys", false)).toBe("?tab=keys");
    expect(queryTabSearch(p, "keys", false, ["orgId"])).toBe("?orgId=org_1&tab=keys");
    expect(queryTabSearch(p, "failures", true, ["orgId"])).toBe("?orgId=org_1");
  });
});

describe("QueryTabs", () => {
  it("is a tablist with the tab from the address selected, links that reset the filters, and the panel labelled by it", () => {
    const html = render("/console/developer?tab=keys&q=acme&orgId=org_1", [
      createElement(QueryTabs, { key: "t", tabs: TABS, label: "Developer platform sections", testIdPrefix: "console-developer-tab", keep: ["orgId"] }),
      createElement(TabPanel, { key: "p", testIdPrefix: "console-developer-tab", current: "keys" }, "panel body"),
    ]);
    expect(html).toContain('role="tablist" aria-label="Developer platform sections"');
    const failures = tab(html, "console-developer-tab-failures");
    expect(failures).toContain('role="tab"');
    expect(failures).toContain('aria-selected="false"');
    expect(failures).toContain('tabindex="-1"');
    expect(failures).toContain('href="/console/developer?orgId=org_1"');
    const keys = tab(html, "console-developer-tab-keys");
    expect(keys).toContain('aria-selected="true"');
    expect(keys).toContain('aria-current="page"');
    expect(keys).toContain('tabindex="0"');
    expect(keys).toContain('href="/console/developer?orgId=org_1&amp;tab=keys"');
    expect(html).toContain("API keys<span>3</span>");
    expect(html).toContain('role="tabpanel" id="console-developer-tab-panel" aria-labelledby="console-developer-tab-keys"');
    expect(html).not.toContain("Billing only");
  });

  it("falls back to the first tab for an unknown or hidden tab, and shows a tab the role may see", () => {
    const hidden = render("/console/developer?tab=secret", createElement(QueryTabs, { tabs: TABS, testIdPrefix: "t" }));
    expect(tab(hidden, "t-failures")).toContain('aria-selected="true"');
    const shown = render("/console/developer?tab=secret", createElement(QueryTabs, { tabs: TABS, testIdPrefix: "t" }), ["billing.read" as Permission]);
    expect(tab(shown, "t-secret")).toContain('aria-selected="true"');
  });
});
