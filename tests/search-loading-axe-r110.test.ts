import { describe, it, expect } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Command } from "cmdk";
import { ContentGroups } from "@/web/components/search-results";

/**
 * R110 (R98 low, verifier and e2e): while a search was loading, the palette list held cmdk's Loading, whose
 * role=progressbar is not allowed inside a listbox (axe aria-required-children, serious) at 1280 light.
 */
describe("search loading inside the palette list", () => {
  it("shows the searching line with no progressbar role inside the listbox", () => {
    const state = { active: true, loading: true, data: null, error: null } as unknown as Parameters<typeof ContentGroups>[0]["state"];
    const html = renderToStaticMarkup(h(Command, { label: "Search" }, h(Command.List, { "aria-busy": true }, h(ContentGroups, { state, search: "kestrel", onOpen: () => {} }))));
    expect(html).toContain("Searching mail, tasks, docs and chat");
    expect(html).toContain('role="listbox"');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("progressbar");
  });
});
