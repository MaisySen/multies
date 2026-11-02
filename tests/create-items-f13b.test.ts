import { describe, expect, it } from "vitest";
import { CREATE_KINDS, createItems, type NavFlags } from "@/web/layouts/shell-nav";

// F13b (MB-309): the top bar Create menu crashed for an owner when an item had no icon (Blog post). Every item the menu
// can show must be a known kind, so the icon map typed by kind covers it.
describe("Create menu items", () => {
  const all = { tools: true, links: true, invoices: true, sitesCreate: true, blogCreate: true, social: true } as NavFlags;
  it("uses only known kinds with every option on", () => {
    const kinds = createItems(all).map((c) => c.kind);
    expect(kinds).toEqual(expect.arrayContaining(["blog", "site", "post", "invoice", "quote", "link"]));
    for (const k of kinds) expect(CREATE_KINDS).toContain(k);
    expect(new Set(kinds).size).toBe(kinds.length);
  });
  it("keeps the base items with every option off", () => {
    expect(createItems({} as NavFlags).map((c) => c.kind)).toEqual(["task", "doc", "mail", "event", "file"].filter((k) => createItems({} as NavFlags).some((c) => c.kind === k)));
  });
});
