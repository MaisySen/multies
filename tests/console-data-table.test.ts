/**
 * OPS1 shared fixes: the console's DataTable, rendered to static markup from a seeded query cache. A list the server
 * says looked only at recent rows gets one quiet line under it; the empty card's action can be replaced or left out;
 * a table that is one section of a page shows the one-line empty row; hand-built tables can pick their own minimum
 * width.
 */
import { describe, it, expect } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DataTable, RECENT_ONLY_NOTE, tableProps, type DataColumn } from "../src/web/pages/console/components/data-table";
import { consoleKeys, type Page } from "../src/web/lib/console-api";

interface Row { id: string; name: string }
const columns: DataColumn<Row>[] = [{ key: "name", header: "Name", cell: (r) => r.name }];

/** Renders a DataTable whose first page is already in the cache (no request is made). */
function render(page: Page<Row>, props: Partial<Parameters<typeof DataTable<Row>>[0]> = {}, url = "/console/x"): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  // The list asks with the address's search, so the cached page is keyed the same way.
  const q = new URL(url, "http://x").searchParams.get("q");
  qc.setQueryData(consoleKeys.list("/things", q ? { q } : {}), { pages: [page], pageParams: [null] });
  const table = createElement(DataTable<Row>, {
    label: "Things", path: "/things", columns, rowKey: (r: Row) => r.id,
    empty: { title: "No things", body: "Things show here." }, ...props,
  });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, { initialEntries: [url] }, table as ReactNode)));
}

describe("DataTable", () => {
  it("says so under the table when the server looked at recent rows only", () => {
    const out = render({ items: [{ id: "a", name: "Alpha" }], nextCursor: null, recentOnly: true });
    expect(out).toContain(">Alpha<");
    expect(out).toContain('data-testid="console-recent-only"');
    expect(out).toContain(RECENT_ONLY_NOTE);
    expect(RECENT_ONLY_NOTE).toBe("Showing recent activity only. Pick a workspace to see older rows.");
    expect(render({ items: [{ id: "a", name: "Alpha" }], nextCursor: null })).not.toContain("console-recent-only");
    // Also under an empty list, and in the page's own words when it gives them.
    expect(render({ items: [], nextCursor: null, recentOnly: true }, { recentNote: "Recent registrations only." })).toContain("Recent registrations only.");
  });

  it("shows the big empty card, with its action replaced or left out", () => {
    const plain = render({ items: [], nextCursor: null });
    expect(plain).toContain("No things");
    expect(plain).not.toContain("console-empty-row");
    // Filtered: the default action clears the search and filters.
    expect(render({ items: [], nextCursor: null }, {}, "/console/x?q=zz")).toContain("Clear search and filters");
    // Left out (the toolbar already offers it) or replaced by the page's own.
    expect(render({ items: [], nextCursor: null }, { empty: { title: "No things", body: "x", action: null } }, "/console/x?q=zz")).not.toContain("Clear search and filters");
    expect(render({ items: [], nextCursor: null }, { empty: { title: "No things", body: "x", action: createElement("button", null, "Show all things") } })).toContain("Show all things");
  });

  it("shows a one-line empty row when the table is one section of a page", () => {
    const out = render({ items: [], nextCursor: null }, { embedded: true, empty: { title: "Nothing held.", body: "No messages are waiting." } });
    expect(out).toContain('data-testid="console-empty-row"');
    expect(out).toContain("Nothing held.");
    expect(out).toContain("No messages are waiting.");
  });

  it("lets a hand-built table pick its minimum width", () => {
    expect(tableProps().style).toEqual({ minWidth: 560 });
    expect(tableProps(420).style).toEqual({ minWidth: 420 });
    expect(tableProps(0).style).toBeUndefined();
    expect(tableProps(0, "extra").className).toContain("extra");
  });
});
