/**
 * R69: every Tools page in one frame (entry keys that exist in the list, links that open the right screen),
 * and smart folders file a statement as a statement.
 */
import { describe, it, expect } from "vitest";
import { catalogueFor } from "@/shared/tools";
import { TOOL_FEATURES } from "@/shared/tool-features";
import { buildEntries } from "@/web/components/tools/tool-directory";
import { entryHref } from "@/web/components/tools/tools-frame";
import { classifyAttachment } from "@/server/services/tools/attachment-classify";

const ALL = [...TOOL_FEATURES];

describe("R69 Tools frame", () => {
  const entries = buildEntries(catalogueFor(ALL), ALL);
  it("has a list entry for every page that uses the shared frame", () => {
    for (const key of ["organize", "form-fill", "compare", "share", "esign", "workflows", "templates", "merge_mail", "ask", "translate", "extract", "expenses", "contracts"]) {
      expect(entries.find((e) => e.key === key), key).toBeTruthy();
    }
  });
  it("opens pages at their own path and tools on the Tools screen", () => {
    const by = (k: string) => entries.find((e) => e.key === k)!;
    expect(entryHref(by("organize"))).toBe("/app/tools/pages");
    expect(entryHref(by("share"))).toBe("/app/tools/share");
    expect(entryHref(by("compress"))).toBe("/app/tools?op=compress");
  });
});

describe("R69 smart folders: statements", () => {
  it("files a document headed Statement with an amount owing under Statements, not Invoices", () => {
    const text = "Statement\nHarbour Plumbing ABN 51 824 753 556\nStatement date 31/10/2026\nInvoice INV-1042  $1,200.00\nInvoice INV-1043  $300.00\nAmount owing $1,500.00\nTotal due $1,500.00";
    expect(classifyAttachment({ filename: "Ada Lovelace.pdf", text })).toBe("statement");
  });
  it("still files a tax invoice as an invoice", () => {
    const text = "Tax invoice\nHarbour Plumbing ABN 51 824 753 556\nInvoice number INV-1042\nDue date 14/11/2026\nTotal due $1,200.00";
    expect(classifyAttachment({ filename: "INV-1042.pdf", text })).toBe("invoice");
  });
});
